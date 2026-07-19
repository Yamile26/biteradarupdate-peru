const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || 'food-discoverer-secret-key-2026';
const DB_PATH = path.join(__dirname, 'db.json');

// --- GEOCODING / UBICACIÓN CONFIG ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const NOMINATIM_USER_AGENT = 'BiteRadarPeru/1.0 (proyecto educativo UNI)';

app.use(cors());
app.use(express.json({ limit: '5mb' })); // el límite por defecto (100kb) no alcanza para el logo en base64
app.use(express.static(path.join(__dirname, 'public')));

// Helper functions for reading/writing db.json
function readDb() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file, returning empty structure:', err);
    return { users: [], businesses: [] };
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing database file:', err);
  }
}

// Haversine formula to calculate distance in km
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// --- SENTIMENT / POSITIVITY SCORE (palabras clave en español) ---
const POSITIVE_WORDS = [
  'excelente', 'increíble', 'increible', 'delicioso', 'deliciosa', 'espectacular',
  'maravilla', 'maravilloso', 'recomendado', 'recomiendo', 'buenísimo', 'buenisimo',
  'rico', 'rica', 'sabroso', 'sabrosa', 'perfecto', 'perfecta', 'genial', 'amable',
  'rápido', 'rapido', 'fresco', 'fresca', 'infaltable', 'mejor', 'mejores', 'top',
  'encanta', 'encantó', 'encanto', 'vale la pena', 'súper', 'super'
];
const NEGATIVE_WORDS = [
  'malo', 'mala', 'pésimo', 'pesimo', 'lento', 'lenta', 'caro', 'cara', 'frío', 'frio',
  'sucio', 'sucia', 'desagradable', 'horrible', 'nunca más', 'nunca mas', 'decepción',
  'decepcion', 'tardaron', 'demora', 'grosero', 'grosera', 'feo', 'fea'
];

function computePositivityScore(reviews) {
  if (!reviews || reviews.length === 0) return 0;
  let hits = 0;
  reviews.forEach(r => {
    const text = (r.comment || '').toLowerCase();
    POSITIVE_WORDS.forEach(w => { if (text.includes(w)) hits += 1; });
    NEGATIVE_WORDS.forEach(w => { if (text.includes(w)) hits -= 1; });
  });
  // Blend the star-rating average (0-5) with the keyword sentiment signal
  const ratingAvg = reviews.reduce((s, r) => s + (r.ratings.foodQuality + r.ratings.service + r.ratings.price) / 3, 0) / reviews.length;
  const sentimentBoost = Math.max(-1, Math.min(1, hits / Math.max(reviews.length, 1))); // -1..1
  const score = ratingAvg + sentimentBoost; // roughly 0-6 range
  return parseFloat(score.toFixed(2));
}

// --- AFORO (CAPACITY) LEVEL HELPER ---
function aforoLevel(aforo) {
  if (!aforo || !aforo.capacidadMaxima) return 'desconocido';
  const pct = aforo.actual / aforo.capacidadMaxima;
  if (pct >= 0.9) return 'lleno';
  if (pct >= 0.6) return 'moderado';
  return 'libre';
}

// --- PROMOTIONS HELPER ---
function isPromotionActive(promotion) {
  if (!promotion || !promotion.activa) return false;
  if (!promotion.validoHasta) return true;
  const today = new Date().toISOString().split('T')[0];
  return promotion.validoHasta >= today;
}

// ==========================================================================
// UBICACIÓN — GEOCODING (Nominatim/OSM, gratis) + INTERPRETACIÓN (Gemini)
// ==========================================================================

// Convierte un texto de dirección/distrito en coordenadas reales usando
// Nominatim (el geocoder gratuito de OpenStreetMap). No requiere API key,
// pero exige un User-Agent identificable y un uso moderado (máx. ~1 req/seg).
async function geocodeWithNominatim(query, limit = 5) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('countrycodes', 'pe');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');

  const response = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept-Language': 'es' },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) throw new Error(`Nominatim respondió ${response.status}`);
  const data = await response.json();

  return data.map(item => ({
    displayName: item.display_name,
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon)
  }));
}

// Usa Gemini para convertir una descripción libre en español ("cerca al
// óvalo de miraflores", "por la UNI en el rímac") en un nombre de lugar
// concreto y buscable. Gemini NUNCA inventa coordenadas — solo interpreta
// texto; las coordenadas reales siempre salen de Nominatim después.
async function interpretLocationWithGemini(text) {
  if (!GEMINI_API_KEY) return null;

  const prompt = `Un usuario en Perú describe dónde está o dónde quiere buscar comida. Devuelve SOLO el nombre de lugar más específico y buscable en un mapa (distrito, urbanización, avenida, universidad, parque o punto de referencia conocido en Perú), sin explicaciones ni comillas ni texto adicional. Si el texto no da pistas suficientes de ubicación, responde exactamente: DESCONOCIDO.

Texto del usuario: "${text}"`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini respondió ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const placeName = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!placeName || placeName.toUpperCase().includes('DESCONOCIDO')) return null;
  return placeName;
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Token missing.' });
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Access denied. Invalid token.' });
    }
    req.user = user;
    next();
  });
}

// --- AUTHENTICATION ENDPOINTS ---

app.post('/api/register', (req, res) => {
  const { email, password, role, businessName, category, latitude, longitude, logo } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const isOwner = role === 'owner';

  if (isOwner) {
    if (!businessName || !businessName.trim()) {
      return res.status(400).json({ error: 'El nombre del negocio es requerido.' });
    }
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Debes marcar la ubicación de tu negocio en el mapa.' });
    }
  }

  const db = readDb();
  const existingUser = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) {
    return res.status(400).json({ error: 'User already exists.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const newUser = {
    id: 'u_' + Math.random().toString(36).substr(2, 9),
    email: email.toLowerCase(),
    passwordHash,
    role: isOwner ? 'owner' : 'client',
    businessId: null
  };

  if (isOwner) {
    const newBusiness = {
      id: 'b_' + Math.random().toString(36).substr(2, 9),
      name: businessName.trim(),
      category: category || 'Street Food',
      image: logo || '/images/ceviche.png',
      latitude,
      longitude,
      ownerId: newUser.id,
      ownerEmail: newUser.email,
      ratings: { foodQuality: 0, service: 0, price: 0 },
      reviews: [],
      aforo: { actual: 0, capacidadMaxima: 30 },
      reservations: [],
      promotion: null
    };
    db.businesses.push(newBusiness);
    newUser.businessId = newBusiness.id;
  }

  db.users.push(newUser);
  writeDb(db);
  res.status(201).json({ message: 'User registered successfully.' });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const db = readDb();
  const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(400).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '24h' });
  res.json({ token, email: user.email, role: user.role || 'client', businessId: user.businessId || null });
});

// --- FOOD BUSINESS ENDPOINTS ---

app.get('/api/businesses', authenticateToken, (req, res) => {
  const db = readDb();

  const userLat = parseFloat(req.query.lat) || -12.1213;
  const userLng = parseFloat(req.query.lng) || -77.0296;
  const categoryFilter = req.query.category;
  const minRatingFilter = parseFloat(req.query.minRating) || 0;
  const sortBy = req.query.sort || 'rating'; // 'rating' | 'positivo' | 'distancia'

  let list = db.businesses.map(b => {
    const distance = calculateDistance(userLat, userLng, b.latitude, b.longitude);
    const avgRating = parseFloat(((b.ratings.foodQuality + b.ratings.service + b.ratings.price) / 3).toFixed(1));
    const walkingTime = Math.round(distance * 12);
    const drivingTime = Math.round(distance * 2) || 1;
    const positivityScore = computePositivityScore(b.reviews);
    const aforo = b.aforo || { actual: 0, capacidadMaxima: 0 };
    const promotion = b.promotion && isPromotionActive(b.promotion) ? b.promotion : null;

    return {
      ...b,
      distance: parseFloat(distance.toFixed(2)),
      averageRating: avgRating,
      walkingTime,
      drivingTime,
      positivityScore,
      aforo: { ...aforo, nivel: aforoLevel(aforo) },
      promotion
    };
  });

  if (categoryFilter && categoryFilter.toLowerCase() !== 'all') {
    list = list.filter(b => b.category.toLowerCase() === categoryFilter.toLowerCase());
  }
  if (minRatingFilter > 0) {
    list = list.filter(b => b.averageRating >= minRatingFilter);
  }

  if (sortBy === 'positivo') {
    list.sort((a, b) => b.positivityScore - a.positivityScore);
  } else if (sortBy === 'distancia') {
    list.sort((a, b) => a.distance - b.distance);
  } else {
    list.sort((a, b) => b.averageRating - a.averageRating);
  }

  res.json({ userLocation: { lat: userLat, lng: userLng }, businesses: list });
});

app.post('/api/businesses/:id/reviews', authenticateToken, (req, res) => {
  const businessId = req.params.id;
  const { comment, ratings } = req.body;

  if (!ratings || ratings.foodQuality === undefined || ratings.service === undefined || ratings.price === undefined) {
    return res.status(400).json({ error: 'Faltan las valoraciones de calidad de comida, servicio o precio.' });
  }

  const db = readDb();
  const business = db.businesses.find(b => b.id === businessId);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado.' });
  if (!business.reviews) business.reviews = [];

  const newReview = {
    id: 'r_' + Math.random().toString(36).substr(2, 9),
    userEmail: req.user.email,
    comment: comment || '',
    ratings: {
      foodQuality: parseFloat(ratings.foodQuality),
      service: parseFloat(ratings.service),
      price: parseFloat(ratings.price)
    },
    createdAt: new Date().toISOString()
  };

  business.reviews.push(newReview);

  const count = business.reviews.length;
  let sumFood = 0, sumService = 0, sumPrice = 0;
  business.reviews.forEach(rev => {
    sumFood += rev.ratings.foodQuality;
    sumService += rev.ratings.service;
    sumPrice += rev.ratings.price;
  });

  business.ratings = {
    foodQuality: parseFloat((sumFood / count).toFixed(1)),
    service: parseFloat((sumService / count).toFixed(1)),
    price: parseFloat((sumPrice / count).toFixed(1))
  };

  writeDb(db);

  const positivityScore = computePositivityScore(business.reviews);

  io.emit('new-review', {
    businessId: business.id,
    businessName: business.name,
    review: newReview
  });

  res.status(201).json({
    message: 'Reseña agregada con éxito.',
    review: newReview,
    updatedRatings: business.ratings,
    positivityScore
  });
});

// --- AFORO (REAL-TIME CAPACITY) ---
app.patch('/api/businesses/:id/aforo', authenticateToken, (req, res) => {
  const businessId = req.params.id;
  const { actual } = req.body;

  if (actual === undefined || isNaN(parseInt(actual))) {
    return res.status(400).json({ error: 'Debes enviar un valor numérico de aforo actual.' });
  }

  const db = readDb();
  const business = db.businesses.find(b => b.id === businessId);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado.' });

  const cap = business.aforo.capacidadMaxima;
  business.aforo.actual = Math.max(0, Math.min(cap, parseInt(actual)));
  writeDb(db);

  const payload = { businessId, aforo: { ...business.aforo, nivel: aforoLevel(business.aforo) } };
  io.emit('aforo-update', payload);
  res.json(payload);
});

// --- RESERVATIONS ---
app.post('/api/businesses/:id/reservations', authenticateToken, (req, res) => {
  const businessId = req.params.id;
  const { date, time, partySize } = req.body;

  if (!date || !time || !partySize) {
    return res.status(400).json({ error: 'Faltan datos: fecha, hora y cantidad de comensales son requeridos.' });
  }

  const db = readDb();
  const business = db.businesses.find(b => b.id === businessId);
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado.' });
  if (!business.reservations) business.reservations = [];

  const newReservation = {
    id: 'res_' + Math.random().toString(36).substr(2, 9),
    userEmail: req.user.email,
    date,
    time,
    partySize: parseInt(partySize),
    createdAt: new Date().toISOString(),
    status: 'confirmada'
  };

  business.reservations.push(newReservation);
  writeDb(db);

  io.emit('new-reservation', {
    businessId: business.id,
    businessName: business.name,
    reservation: newReservation
  });

  res.status(201).json({
    message: `Reserva confirmada en ${business.name} para ${partySize} persona(s) el ${date} a las ${time}.`,
    reservation: newReservation
  });
});

app.get('/api/my-reservations', authenticateToken, (req, res) => {
  const db = readDb();
  const myReservations = [];
  db.businesses.forEach(b => {
    (b.reservations || []).forEach(r => {
      if (r.userEmail === req.user.email) {
        myReservations.push({ ...r, businessId: b.id, businessName: b.name });
      }
    });
  });
  myReservations.sort((a, b) => new Date(a.date + 'T' + a.time) - new Date(b.date + 'T' + b.time));
  res.json(myReservations);
});

// Get Categories List
app.get('/api/categories', (req, res) => {
  const db = readDb();
  const categories = [...new Set(db.businesses.map(b => b.category))];
  res.json(categories);
});

// --- UBICACIÓN: buscador de direcciones (autocomplete) ---
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) {
    return res.status(400).json({ error: 'Escribe al menos 3 caracteres para buscar.' });
  }

  try {
    const results = await geocodeWithNominatim(q);
    res.json({ results });
  } catch (err) {
    console.error('Error en geocoding:', err.message);
    res.status(502).json({ error: 'No se pudo buscar la dirección en este momento.' });
  }
});

// --- UBICACIÓN: interpretar descripción libre con Gemini + geocodificar ---
app.post('/api/location/interpret', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (text.length < 3) {
    return res.status(400).json({ error: 'Cuéntanos un poco más sobre dónde estás.' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(501).json({
      error: 'El chat de ubicación no está configurado (falta GEMINI_API_KEY en el servidor). Usa el buscador de direcciones mientras tanto.'
    });
  }

  try {
    const placeName = await interpretLocationWithGemini(text);
    if (!placeName) {
      return res.status(422).json({ error: 'No logré identificar un lugar en esa descripción. ¿Puedes ser más específico? (ej. distrito, avenida, universidad, parque cercano)' });
    }

    const results = await geocodeWithNominatim(placeName, 3);
    if (results.length === 0) {
      return res.status(404).json({ error: `Entendí "${placeName}", pero no encontré esa ubicación en el mapa. Prueba con el buscador de direcciones.`, placeName });
    }

    res.json({ placeName, results });
  } catch (err) {
    console.error('Error interpretando ubicación:', err.message);
    res.status(502).json({ error: 'Hubo un problema interpretando tu ubicación. Intenta con el buscador de direcciones.' });
  }
});

// Get Active Promotions (for the promo carousel)
app.get('/api/promotions', (req, res) => {
  const db = readDb();
  const promos = db.businesses
    .filter(b => isPromotionActive(b.promotion))
    .map(b => ({
      businessId: b.id,
      businessName: b.name,
      category: b.category,
      image: b.image,
      ...b.promotion
    }));
  res.json(promos);
});

// Get Peruvian Gastronomic Festivities Calendar
app.get('/api/festivities', (req, res) => {
  const festivities = [
    { id: 'f1', name: 'Día del Pisco Sour', date: '2026-02-07', month: 2, day: 7, emoji: '🍹',
      description: 'El primer sábado de febrero se celebra el Día Nacional del Pisco Sour, la bebida bandera del Perú. Bares y restaurantes ofrecen ediciones especiales de este cóctel hecho con pisco, limón, clara de huevo y amargo de angostura.',
      category: null, color: '#f59e0b' },
    { id: 'f2', name: 'Día de la Madre', date: '2026-05-10', month: 5, day: 10, emoji: '💐',
      description: 'El segundo domingo de mayo, los restaurantes peruanos se llenan de familias celebrando a las madres. Es el día con mayor reservas en todo el año. ¡Lleva a tu mamá a su cevichería favorita!',
      category: 'Cevichería', color: '#ec4899' },
    { id: 'f3', name: 'Día del Ceviche', date: '2026-06-28', month: 6, day: 28, emoji: '🐟',
      description: 'El 28 de junio se celebra el Día Nacional del Ceviche, declarado Patrimonio Cultural de la Nación. Cevicherías de todo el país ofrecen promociones especiales. ¡No te lo puedes perder!',
      category: 'Cevichería', color: '#06b6d4' },
    { id: 'f4', name: 'Día del Pollo a la Brasa', date: '2026-07-19', month: 7, day: 19, emoji: '🍗',
      description: 'El tercer domingo de julio es el Día Nacional del Pollo a la Brasa. Este plato, preparado con una mezcla secreta de especias y cocinado en horno de leña, es uno de los más consumidos en el Perú. Las pollerías ofrecen promociones imperdibles.',
      category: 'Pollería', color: '#f97316' },
    { id: 'f5', name: 'Fiestas Patrias', date: '2026-07-28', month: 7, day: 28, emoji: '🇵🇪',
      description: 'El 28 y 29 de julio son los días más importantes del Perú. La comida criolla reina en las mesas de todo el país: ceviche, lomo saltado, anticuchos y picarones son los protagonistas de estas celebraciones patrias.',
      category: 'Criollo', color: '#ef4444' },
    { id: 'f6', name: 'Día del Anticucho', date: '2026-10-18', month: 10, day: 18, emoji: '🍢',
      description: 'El tercer domingo de octubre Lima se llena del aroma a anticuchos. Los pinchos de corazón marinados en ají panca y vinagre, asados en parrilla, son una tradición infaltable de la gastronomía callejera peruana.',
      category: 'Anticuchería', color: '#dc2626' },
    { id: 'f7', name: 'Día de la Canción Criolla', date: '2026-10-31', month: 10, day: 31, emoji: '🎵',
      description: 'El 31 de octubre se celebra el Día de la Canción Criolla. Los restaurantes criollos organizan peñas con música en vivo, marinera norteña y platos típicos. ¡Una noche para celebrar la cultura peruana!',
      category: 'Criollo', color: '#7c3aed' }
  ];

  const today = new Date();
  const result = festivities.map(f => {
    const festDate = new Date(`${f.date}T12:00:00`);
    const diffDays = Math.ceil((festDate - today) / (1000 * 60 * 60 * 24));
    return {
      ...f,
      daysUntil: diffDays,
      isToday: diffDays === 0,
      isTomorrow: diffDays === 1,
      isUpcoming: diffDays > 0 && diffDays <= 7,
      isPast: diffDays < 0
    };
  });

  res.json(result);
});

// ==========================================================================
// SOCKET.IO — REAL-TIME AFORO SIMULATION
// ==========================================================================
// En producción esto vendría de un sensor real de aforo o de un panel del
// dueño del negocio llamando a PATCH /api/businesses/:id/aforo. Por ahora
// simulamos una fluctuación natural para que la experiencia "en tiempo
// real" funcione de punta a punta sin hardware adicional.
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  socket.on('disconnect', () => console.log('Cliente desconectado:', socket.id));
});

setInterval(() => {
  const db = readDb();
  let changed = false;

  db.businesses.forEach(b => {
    if (!b.aforo) return;
    const cap = b.aforo.capacidadMaxima;
    const delta = Math.round((Math.random() - 0.5) * 6); // -3..+3 personas
    const next = Math.max(0, Math.min(cap, b.aforo.actual + delta));
    if (next !== b.aforo.actual) {
      b.aforo.actual = next;
      changed = true;
      io.emit('aforo-update', { businessId: b.id, aforo: { ...b.aforo, nivel: aforoLevel(b.aforo) } });
    }
  });

  if (changed) writeDb(db);
}, 12000);

// Start Server
server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
