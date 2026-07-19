// ==========================================================================
// GLOBAL STATE
// ==========================================================================
const state = {
  token: localStorage.getItem('token') || null,
  email: localStorage.getItem('email') || null,
  coords: null,
  notifications: [],
  notifOpen: false,
  currentTab: 'explore',
  accountType: 'client',
  ownerLogoDataUrl: null,
  ownerLocation: null
};

const API_BASE = window.location.origin;

// Leaflet Map
let map = null;
let markersGroup = null;

// Mini mapa de registro (para dueños de negocio)
let registerMap = null;
let registerMapMarker = null;

// Socket.IO (aforo en tiempo real)
let socket = null;

// Category → color mapping used for map markers, legend and badges
const CATEGORY_COLORS = {
  'Cevichería': '#0EA5E9',
  'Pollería': '#F97316',
  'Sanguchería': '#EAB308',
  'Anticuchería': '#DC2626',
  'Chifa': '#A21CAF',
  'Postres': '#EC4899',
  'Criollo': '#16A34A',
  'Street Food': '#78716C'
};
const DEFAULT_CATEGORY_COLOR = '#F97316';

function categoryColor(category) {
  return CATEGORY_COLORS[category] || DEFAULT_CATEGORY_COLOR;
}

// ==========================================================================
// BOOT
// ==========================================================================
function startApp() {
  initAuthUI();
  if (state.token) {
    showMainApp();
  } else {
    showAuthScreen();
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

// Close notifications if click outside
document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('notif-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    document.getElementById('notif-dropdown').classList.add('hidden');
    state.notifOpen = false;
  }
});

// ==========================================================================
// AUTH UI
// ==========================================================================
function initAuthUI() {
  const container = document.getElementById('auth-status-container');
  if (state.token && state.email) {
    container.innerHTML = `
      <span class="user-email">${state.email}</span>
      <button class="btn btn-secondary" onclick="handleLogout()">Cerrar Sesión</button>
    `;
  } else {
    container.innerHTML = `<span class="text-dark">No has iniciado sesión</span>`;
  }
}

function showAuthScreen() {
  document.getElementById('auth-view').classList.remove('hidden');
  document.getElementById('main-view').classList.add('hidden');
  initAuthUI();
}

function showMainApp() {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
  initAuthUI();
  requestLocation();
  fetchCategories();
  fetchFestivities();
  fetchPromotions();
  connectRealtime();
  initAddressSearch();
}

// ==========================================================================
// SOCKET.IO — AFORO EN TIEMPO REAL
// ==========================================================================
function connectRealtime() {
  if (socket) return;
  socket = io(API_BASE);

  socket.on('aforo-update', (payload) => {
    updateAforoBadge(payload.businessId, payload.aforo);
  });

  socket.on('new-review', (payload) => {
    addNotification({
      id: 'review-' + payload.review.id,
      emoji: '💬',
      title: `Nueva opinión en ${payload.businessName}`,
      subtitle: 'Alguien acaba de compartir su experiencia.',
      category: null
    });
  });
}

function disconnectRealtime() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function aforoLabel(nivel) {
  if (nivel === 'lleno') return 'Lleno';
  if (nivel === 'moderado') return 'Moderado';
  if (nivel === 'libre') return 'Libre';
  return 'Sin datos';
}

function updateAforoBadge(businessId, aforo) {
  const badge = document.getElementById(`aforo-${businessId}`);
  if (!badge) return;
  badge.className = `aforo-badge aforo-${aforo.nivel}`;
  badge.innerHTML = `
    <span class="aforo-dot"></span>
    ${aforoLabel(aforo.nivel)}
    <span class="aforo-count">(${aforo.actual}/${aforo.capacidadMaxima})</span>
  `;
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('login-form').classList.toggle('hidden', !isLogin);
  document.getElementById('register-form').classList.toggle('hidden', isLogin);
}

// ==========================================================================
// TIPO DE CUENTA (cliente vs. dueño de negocio) — en el registro
// ==========================================================================
function selectAccountType(type) {
  state.accountType = type;
  const isOwner = type === 'owner';

  document.getElementById('account-type-client').classList.toggle('active', !isOwner);
  document.getElementById('account-type-owner').classList.toggle('active', isOwner);
  document.getElementById('owner-fields').classList.toggle('hidden', !isOwner);

  // Los campos del negocio solo son obligatorios si el usuario es dueño
  document.getElementById('register-business-name').required = isOwner;

  if (isOwner) {
    // El mapa necesita el contenedor visible para calcular su tamaño,
    // por eso se inicializa (o se refresca) justo al mostrar la sección.
    setTimeout(initRegisterMap, 50);
  }
}

function initRegisterMap() {
  const defaultLat = state.coords ? state.coords.lat : -12.1213;
  const defaultLng = state.coords ? state.coords.lng : -77.0296;

  if (!registerMap) {
    registerMap = L.map('register-map').setView([defaultLat, defaultLng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(registerMap);

    registerMap.on('click', (e) => setOwnerLocation(e.latlng.lat, e.latlng.lng));
  } else {
    registerMap.invalidateSize();
  }
}

function setOwnerLocation(lat, lng) {
  state.ownerLocation = { lat, lng };

  if (!registerMapMarker) {
    registerMapMarker = L.marker([lat, lng], { draggable: true }).addTo(registerMap);
    registerMapMarker.on('dragend', () => {
      const pos = registerMapMarker.getLatLng();
      setOwnerLocation(pos.lat, pos.lng);
    });
  } else {
    registerMapMarker.setLatLng([lat, lng]);
  }

  document.getElementById('owner-location-text').textContent =
    `📍 Ubicación marcada: (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
}

function handleLogoFileChange(event) {
  const file = event.target.files && event.target.files[0];
  const preview = document.getElementById('logo-preview');
  const uploadText = document.getElementById('logo-upload-text');
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    state.ownerLogoDataUrl = reader.result;
    preview.src = reader.result;
    preview.classList.remove('hidden');
    uploadText.textContent = file.name;
  };
  reader.readAsDataURL(file);
}

function resetOwnerRegistrationFields() {
  state.accountType = 'client';
  state.ownerLogoDataUrl = null;
  state.ownerLocation = null;
  registerMapMarker = null;
  if (registerMap) { registerMap.remove(); registerMap = null; }

  document.getElementById('account-type-client').classList.add('active');
  document.getElementById('account-type-owner').classList.remove('active');
  document.getElementById('owner-fields').classList.add('hidden');
  document.getElementById('logo-preview').classList.add('hidden');
  document.getElementById('logo-upload-text').textContent = 'Subir logo (opcional)';
  document.getElementById('owner-location-text').textContent = 'Aún no marcaste una ubicación.';
}

// ==========================================================================
// MAIN TAB SWITCHING
// ==========================================================================
function switchMainTab(tab) {
  state.currentTab = tab;
  document.getElementById('tab-explore').classList.toggle('active', tab === 'explore');
  document.getElementById('tab-calendar').classList.toggle('active', tab === 'calendar');
  document.getElementById('explore-view').classList.toggle('hidden', tab !== 'explore');
  document.getElementById('calendar-view').classList.toggle('hidden', tab !== 'calendar');
}

// ==========================================================================
// AUTH HANDLERS
// ==========================================================================
async function handleRegister(event) {
  event.preventDefault();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const confirmPassword = document.getElementById('register-confirm-password').value;
  const errorEl = document.getElementById('register-error');
  errorEl.classList.add('hidden');

  if (password !== confirmPassword) {
    errorEl.textContent = 'Las contraseñas no coinciden.';
    errorEl.classList.remove('hidden');
    return;
  }

  const payload = { email, password, role: state.accountType };

  if (state.accountType === 'owner') {
    const businessName = document.getElementById('register-business-name').value.trim();
    const category = document.getElementById('register-business-category').value;

    if (!businessName) {
      errorEl.textContent = 'Cuéntanos el nombre de tu local o carrito.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!state.ownerLocation) {
      errorEl.textContent = 'Marca la ubicación de tu negocio en el mapa.';
      errorEl.classList.remove('hidden');
      return;
    }

    payload.businessName = businessName;
    payload.category = category;
    payload.latitude = state.ownerLocation.lat;
    payload.longitude = state.ownerLocation.lng;
    payload.logo = state.ownerLogoDataUrl || null;
  }

  try {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al registrarse.');
    await performLogin(email, password);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');

  try {
    await performLogin(email, password);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

async function performLogin(email, password) {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Credenciales incorrectas.');

  state.token = data.token;
  state.email = data.email;
  localStorage.setItem('token', data.token);
  localStorage.setItem('email', data.email);
  showMainApp();
}

function handleLogout() {
  state.token = null;
  state.email = null;
  state.notifications = [];
  localStorage.removeItem('token');
  localStorage.removeItem('email');
  document.getElementById('login-form').reset();
  document.getElementById('register-form').reset();
  resetOwnerRegistrationFields();
  if (map) { map.remove(); map = null; markersGroup = null; }
  disconnectRealtime();
  showAuthScreen();
}

// ==========================================================================
// GEOLOCATION
// ==========================================================================
function requestLocation() {
  const textEl = document.getElementById('location-text');
  textEl.textContent = 'Solicitando coordenadas GPS...';

  if (!navigator.geolocation) {
    textEl.textContent = 'Tu navegador no soporta geolocalización. Usando Miraflores, Lima.';
    setCoordinates(-12.1213, -77.0296, true);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => setCoordinates(pos.coords.latitude, pos.coords.longitude, false),
    () => {
      textEl.textContent = 'Ubicación denegada. Usando Miraflores, Lima (predeterminado).';
      setCoordinates(-12.1213, -77.0296, true);
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function setCoordinates(lat, lng, isFallback) {
  state.coords = { lat, lng };

  const textEl = document.getElementById('location-text');
  if (!isFallback) textEl.textContent = `Ubicación activa: (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

  if (!map) {
    map = L.map('map').setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    markersGroup = L.layerGroup().addTo(map);
  } else {
    map.setView([lat, lng], 15);
  }

  fetchBusinesses();
}

function setManualLocation(lat, lng, label) {
  setCoordinates(lat, lng, false);
  const textEl = document.getElementById('location-text');
  textEl.textContent = `📍 ${label}`;
}

// ==========================================================================
// BÚSQUEDA DE DIRECCIÓN (Nominatim, con autocomplete)
// ==========================================================================
let addressSearchTimeout = null;

function initAddressSearch() {
  const input = document.getElementById('address-search-input');
  const suggestionsBox = document.getElementById('address-suggestions');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = 'true';

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(addressSearchTimeout);

    if (query.length < 3) {
      suggestionsBox.classList.add('hidden');
      suggestionsBox.innerHTML = '';
      return;
    }

    addressSearchTimeout = setTimeout(() => searchAddress(query), 450);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.location-search-box') && !e.target.closest('.address-suggestions')) {
      suggestionsBox.classList.add('hidden');
    }
  });
}

async function searchAddress(query) {
  const suggestionsBox = document.getElementById('address-suggestions');
  try {
    const res = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al buscar.');

    if (!data.results || data.results.length === 0) {
      suggestionsBox.innerHTML = `<div class="address-suggestion-item">Sin resultados para "${escapeHtml(query)}".</div>`;
      suggestionsBox.classList.remove('hidden');
      return;
    }

    suggestionsBox.innerHTML = data.results.map((r, i) => `
      <div class="address-suggestion-item" onclick='selectAddressResult(${JSON.stringify(r).replace(/'/g, "&apos;")})'>
        📍 ${escapeHtml(r.displayName)}
      </div>
    `).join('');
    suggestionsBox.classList.remove('hidden');
  } catch (err) {
    suggestionsBox.innerHTML = `<div class="address-suggestion-item">${escapeHtml(err.message)}</div>`;
    suggestionsBox.classList.remove('hidden');
  }
}

function selectAddressResult(result) {
  document.getElementById('address-search-input').value = result.displayName;
  document.getElementById('address-suggestions').classList.add('hidden');
  setManualLocation(result.lat, result.lon, result.displayName);
}

// ==========================================================================
// CHAT DE UBICACIÓN DE RESPALDO (Gemini interpreta texto libre → Nominatim)
// ==========================================================================
function toggleLocationChat() {
  document.getElementById('location-chat-box').classList.toggle('hidden');
}

async function submitLocationChat() {
  const textarea = document.getElementById('location-chat-text');
  const resultBox = document.getElementById('location-chat-result');
  const text = textarea.value.trim();

  if (text.length < 3) {
    resultBox.innerHTML = `<span class="error-text">Cuéntanos un poco más sobre dónde estás.</span>`;
    return;
  }

  resultBox.innerHTML = `<span>Interpretando tu ubicación...</span>`;

  try {
    const res = await fetch(`${API_BASE}/api/location/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo interpretar tu ubicación.');

    if (data.results.length === 1) {
      const r = data.results[0];
      setManualLocation(r.lat, r.lon, r.displayName);
      resultBox.innerHTML = `<span class="success-text">✅ Entendido: ${escapeHtml(data.placeName)} → ${escapeHtml(r.displayName)}</span>`;
    } else {
      resultBox.innerHTML = `
        <span class="success-text">Entendí "${escapeHtml(data.placeName)}". ¿Cuál es la correcta?</span>
        <div class="location-chat-candidates">
          ${data.results.map(r => `
            <button type="button" class="location-chat-candidate" onclick='selectAddressResult(${JSON.stringify(r).replace(/'/g, "&apos;")})'>
              📍 ${escapeHtml(r.displayName)}
            </button>
          `).join('')}
        </div>
      `;
    }
  } catch (err) {
    resultBox.innerHTML = `<span class="error-text">${escapeHtml(err.message)}</span>`;
  }
}

// ==========================================================================
// NOTIFICATIONS
// ==========================================================================
function toggleNotifications() {
  const dropdown = document.getElementById('notif-dropdown');
  state.notifOpen = !state.notifOpen;
  dropdown.classList.toggle('hidden', !state.notifOpen);
}

function clearNotifications() {
  state.notifications = [];
  renderNotifications();
}

function addNotification(notif) {
  // Avoid duplicate IDs
  if (!state.notifications.find(n => n.id === notif.id)) {
    state.notifications.push(notif);
  }
  renderNotifications();
}

function renderNotifications() {
  const list = document.getElementById('notif-list');
  const badge = document.getElementById('notif-badge');
  const bell = document.getElementById('notif-bell');
  const count = state.notifications.length;

  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
  bell.classList.toggle('has-alerts', count > 0);

  if (count === 0) {
    list.innerHTML = '<p class="notif-empty">No hay notificaciones activas.</p>';
    return;
  }

  list.innerHTML = state.notifications.map(n => `
    <div class="notif-item" onclick="handleNotifClick('${n.category || ''}')">
      <span class="notif-emoji">${n.emoji}</span>
      <div class="notif-content">
        <span class="notif-title">${n.title}</span>
        <span class="notif-sub">${n.subtitle}</span>
      </div>
    </div>
  `).join('');
}

function handleNotifClick(category) {
  // Close dropdown
  document.getElementById('notif-dropdown').classList.add('hidden');
  state.notifOpen = false;

  // Switch to Explore tab
  switchMainTab('explore');

  // Apply category filter if a category is provided
  if (category) {
    const sel = document.getElementById('filter-category');
    if (sel) {
      // Wait for categories to be loaded then set
      const trySet = setInterval(() => {
        const opt = Array.from(sel.options).find(o => o.value === category);
        if (opt) {
          sel.value = category;
          fetchBusinesses();
          clearInterval(trySet);
        }
      }, 200);
    }
  }
}

// ==========================================================================
// FESTIVITIES / CALENDAR
// ==========================================================================
async function fetchFestivities() {
  try {
    const res = await fetch(`${API_BASE}/api/festivities`);
    if (!res.ok) return;
    const festivities = await res.json();

    // Generate notifications for today / tomorrow / within 7 days
    festivities.forEach(f => {
      if (f.isToday) {
        addNotification({
          id: f.id,
          emoji: f.emoji,
          title: `¡Hoy es ${f.name}! ${f.emoji}`,
          subtitle: '¡Celebra visitando tu local favorito hoy!',
          category: f.category
        });
      } else if (f.isTomorrow) {
        addNotification({
          id: f.id,
          emoji: f.emoji,
          title: `Mañana: ${f.name} ${f.emoji}`,
          subtitle: `¡Prepárate! Mañana es un día gastronómico especial.`,
          category: f.category
        });
      } else if (f.isUpcoming) {
        addNotification({
          id: f.id,
          emoji: f.emoji,
          title: `En ${f.daysUntil} días: ${f.name}`,
          subtitle: `Próxima festividad gastronómica peruana.`,
          category: f.category
        });
      }
    });

    renderCalendar(festivities);
  } catch (err) {
    console.error('Error fetching festivities:', err);
  }
}

// ==========================================================================
// PROMOCIONES Y DESCUENTOS
// ==========================================================================
async function fetchPromotions() {
  try {
    const res = await fetch(`${API_BASE}/api/promotions`);
    if (!res.ok) return;
    const promos = await res.json();
    renderPromoCarousel(promos);
  } catch (err) {
    console.error('Error fetching promotions:', err);
  }
}

function renderPromoCarousel(promos) {
  const section = document.getElementById('promo-section');
  const carousel = document.getElementById('promo-carousel');
  if (!section || !carousel) return;

  if (!promos || promos.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  carousel.innerHTML = promos.map(p => `
    <div class="promo-card" onclick="focusBusinessCard('${p.businessId}')">
      <img src="${p.image || '/images/ceviche.png'}" alt="${escapeHtml(p.businessName)}" loading="lazy">
      <span class="promo-discount-tag">-${p.descuentoPct}%</span>
      <div class="promo-card-overlay">
        <div class="promo-card-business">${escapeHtml(p.businessName)}</div>
        <div class="promo-card-title">${escapeHtml(p.titulo)}</div>
      </div>
    </div>
  `).join('');
}

const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function renderCalendar(festivities) {
  const container = document.getElementById('festivities-list');
  if (!container) return;

  // Sort: upcoming first, then past
  const sorted = [...festivities].sort((a, b) => {
    if (a.isPast && !b.isPast) return 1;
    if (!a.isPast && b.isPast) return -1;
    return a.daysUntil - b.daysUntil;
  });

  container.innerHTML = sorted.map((f, idx) => {
    let statusClass = 'status-past';
    let statusLabel = 'Pasado';

    if (f.isToday) { statusClass = 'status-today'; statusLabel = '¡Hoy!'; }
    else if (f.isTomorrow) { statusClass = 'status-tomorrow'; statusLabel = '¡Mañana!'; }
    else if (f.isUpcoming) { statusClass = 'status-upcoming'; statusLabel = `En ${f.daysUntil} días`; }

    let cardClass = 'festivity-card';
    if (f.isToday) cardClass += ' is-today';
    else if (f.isUpcoming || f.isTomorrow) cardClass += ' is-upcoming';
    else if (f.isPast) cardClass += ' is-past';

    const dateObj = new Date(f.date + 'T12:00:00');
    const dayName = dateObj.toLocaleDateString('es-PE', { weekday: 'long' });
    const formattedDate = `${dayName.charAt(0).toUpperCase() + dayName.slice(1)}, ${dateObj.getDate()} de ${MONTH_NAMES[dateObj.getMonth()]}`;

    const actionBtn = f.category ? `
      <div class="festivity-action">
        <button class="btn-festivity" onclick="goToCategory('${f.category}')">
          Ver ${f.category}s cercanas →
        </button>
      </div>
    ` : '';

    return `
      <div class="${cardClass}" style="--festivity-color: ${f.color}; animation-delay: ${idx * 0.07}s;">
        <div class="festivity-top">
          <span class="festivity-emoji">${f.emoji}</span>
          <span class="festivity-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="festivity-name">${f.name}</div>
        <div class="festivity-date">📅 ${formattedDate}</div>
        <p class="festivity-desc">${f.description}</p>
        ${actionBtn}
      </div>
    `;
  }).join('');
}

function goToCategory(category) {
  switchMainTab('explore');
  const sel = document.getElementById('filter-category');
  if (sel) {
    const trySet = setInterval(() => {
      const opt = Array.from(sel.options).find(o => o.value === category);
      if (opt) {
        sel.value = category;
        fetchBusinesses();
        clearInterval(trySet);
      }
    }, 200);
  }
}

// ==========================================================================
// BUSINESSES: FETCH & RENDER
// ==========================================================================
async function fetchCategories() {
  try {
    const res = await fetch(`${API_BASE}/api/categories`);
    if (!res.ok) return;
    const categories = await res.json();
    const select = document.getElementById('filter-category');
    const currentVal = select.value;
    select.innerHTML = '<option value="all">Todas las Categorías</option>';
    categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });
    if (categories.includes(currentVal)) select.value = currentVal;
  } catch (err) {
    console.error('Error fetching categories:', err);
  }
}

async function fetchBusinesses() {
  if (!state.token || !state.coords) return;

  const spinner = document.getElementById('loading-spinner');
  const emptyState = document.getElementById('empty-state');
  const listContainer = document.getElementById('businesses-list');
  const countEl = document.getElementById('results-count');

  spinner.classList.remove('hidden');
  emptyState.classList.add('hidden');
  listContainer.classList.add('hidden');
  countEl.textContent = '0 encontrados';

  const category = document.getElementById('filter-category').value;
  const minRating = document.getElementById('filter-rating').value;
  const sort = document.getElementById('filter-sort').value;

  try {
    const query = new URLSearchParams({
      lat: state.coords.lat, lng: state.coords.lng,
      category, minRating, sort
    });

    const res = await fetch(`${API_BASE}/api/businesses?${query}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });

    if (res.status === 401 || res.status === 403) { handleLogout(); return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al cargar los negocios.');

    renderBusinesses(data.businesses);
  } catch (err) {
    listContainer.innerHTML = `<div class="error-message">${err.message}</div>`;
    listContainer.classList.remove('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

function renderMapLegend(businesses) {
  const legend = document.getElementById('map-legend');
  if (!legend) return;
  const categoriesInView = [...new Set(businesses.map(b => b.category))];

  if (categoriesInView.length === 0) {
    legend.innerHTML = '';
    return;
  }

  legend.innerHTML = categoriesInView.map(cat => `
    <span class="legend-chip">
      <span class="legend-dot" style="background:${categoryColor(cat)}"></span>
      ${escapeHtml(cat)}
    </span>
  `).join('');
}

function renderBusinesses(businesses) {
  const listContainer = document.getElementById('businesses-list');
  const emptyState = document.getElementById('empty-state');
  const countEl = document.getElementById('results-count');

  listContainer.innerHTML = '';
  countEl.textContent = `${businesses.length} encontrados`;

  // Update map markers
  if (markersGroup) {
    markersGroup.clearLayers();

    // User marker
    L.circleMarker([state.coords.lat, state.coords.lng], {
      radius: 8, fillColor: '#3b82f6', color: '#fff',
      weight: 2, opacity: 1, fillOpacity: 0.9
    }).addTo(markersGroup).bindPopup('<b>Tu ubicación</b>');

    // Business markers — colored by category
    businesses.forEach(b => {
      const color = categoryColor(b.category);
      const marker = L.circleMarker([b.latitude, b.longitude], {
        radius: 9,
        fillColor: color,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.95
      }).addTo(markersGroup);
      marker.bindPopup(`
        <div style="min-width:160px;">
          <div class="map-popup-title">${escapeHtml(b.name)}</div>
          <div class="map-popup-category">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:4px;"></span>
            ${escapeHtml(b.category)}
          </div>
          <div class="map-popup-rating">
            <svg style="width:12px;height:12px;fill:#fbbf24;vertical-align:middle;margin-right:2px;" viewBox="0 0 24 24">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
            <strong>${b.averageRating.toFixed(1)}</strong>
          </div>
          <a class="map-popup-link" onclick="focusBusinessCard('${b.id}')">Ver en la lista</a>
        </div>
      `);
    });
  }

  renderMapLegend(businesses);

  if (businesses.length === 0) {
    emptyState.classList.remove('hidden');
    listContainer.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  listContainer.classList.remove('hidden');

  businesses.forEach((b, idx) => {
    const distanceStr = b.distance < 1
      ? `${Math.round(b.distance * 1000)} m`
      : `${b.distance.toFixed(2)} km`;

    const card = document.createElement('article');
    card.className = 'business-card';
    card.id = `card-${b.id}`;
    card.style.animationDelay = `${idx * 0.05}s`;

    const reviewsHtml = b.reviews && b.reviews.length > 0
      ? b.reviews.map(r => `
          <div class="review-item">
            <div class="review-meta">
              <span class="review-user">${escapeHtml(r.userEmail)}</span>
              <span class="review-date">${new Date(r.createdAt).toLocaleDateString('es-PE')}</span>
            </div>
            <p class="review-comment">"${escapeHtml(r.comment)}"</p>
            <div class="review-ratings">
              <span>Calidad: <strong>${r.ratings.foodQuality}</strong></span>
              <span>Servicio: <strong>${r.ratings.service}</strong></span>
              <span>Precio: <strong>${r.ratings.price}</strong></span>
            </div>
          </div>`).join('')
      : `<p class="text-dark" style="font-size:.9rem;font-style:italic;margin-bottom:.5rem;">No hay opiniones todavía. ¡Sé el primero!</p>`;

    const imageSrc = b.image || '/images/ceviche.png';
    const promoRibbon = b.promotion
      ? `<span class="card-promo-ribbon">🔥 -${b.promotion.descuentoPct}%</span>`
      : '';

    card.innerHTML = `
      <div class="card-image-wrapper">
        ${promoRibbon}
        <img src="${imageSrc}" alt="${escapeHtml(b.name)}" loading="lazy">
        <div class="card-image-overlay"></div>
      </div>

      <div class="card-left">
        <span class="category-tag">${escapeHtml(b.category)}</span>
        <h3 class="business-name">${escapeHtml(b.name)}</h3>
        <div class="metrics-row">
          <div class="metric-item">
            <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            <span>Distancia: <strong>${distanceStr}</strong></span>
          </div>
          <div class="metric-item">
            <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
            <span>A pie: <strong>${b.walkingTime} min</strong></span>
          </div>
          <div class="metric-item">
            <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span>En auto: <strong>${b.drivingTime} min</strong></span>
          </div>
        </div>
        <div class="metrics-row" style="margin-top:0.6rem;">
          <span id="aforo-${b.id}" class="aforo-badge aforo-${b.aforo.nivel}">
            <span class="aforo-dot"></span>
            ${aforoLabel(b.aforo.nivel)}
            <span class="aforo-count">(${b.aforo.actual}/${b.aforo.capacidadMaxima})</span>
          </span>
        </div>
      </div>

      <div class="card-right">
        <div class="avg-rating-badge" title="Valoración promedio">
          <svg class="icon" viewBox="0 0 24 24">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          <span>${b.averageRating.toFixed(1)}</span>
        </div>
        <div class="detailed-ratings">
          <div class="rating-bar"><span class="rating-bar-label">Calidad:</span><span class="rating-bar-value">${b.ratings.foodQuality.toFixed(1)}</span></div>
          <div class="rating-bar"><span class="rating-bar-label">Servicio:</span><span class="rating-bar-value">${b.ratings.service.toFixed(1)}</span></div>
          <div class="rating-bar"><span class="rating-bar-label">Precio:</span><span class="rating-bar-value">${b.ratings.price.toFixed(1)}</span></div>
        </div>
      </div>

      <div class="card-actions-row">
        <button class="btn-toggle-reviews" onclick="toggleReviews('${b.id}')">
          💬 Opiniones e Historias (${b.reviews ? b.reviews.length : 0})
        </button>
        <button class="btn-reservar" onclick="toggleReservation('${b.id}')">
          📅 Reservar Mesa
        </button>
      </div>

      <div id="reservation-${b.id}" class="reservation-drawer hidden">
        <div class="review-form-title">📅 Reserva tu mesa en ${escapeHtml(b.name)}</div>
        <form class="reservation-form" onsubmit="submitReservation(event, '${b.id}')">
          <div class="form-row">
            <div class="form-subgroup">
              <label>Fecha</label>
              <input type="date" name="date" required min="${new Date().toISOString().split('T')[0]}">
            </div>
            <div class="form-subgroup">
              <label>Hora</label>
              <input type="time" name="time" required>
            </div>
            <div class="form-subgroup">
              <label>Comensales</label>
              <input type="number" name="partySize" min="1" max="30" value="2" required>
            </div>
          </div>
          <button type="submit" class="btn-reservar" style="width:100%;justify-content:center;">Confirmar Reserva</button>
        </form>
        <div id="reservation-result-${b.id}"></div>
      </div>

      <div id="drawer-${b.id}" class="reviews-drawer hidden">
        <div class="reviews-header">Experiencias de la Comunidad</div>
        <div class="reviews-list">${reviewsHtml}</div>
        <div class="review-form-container">
          <div class="review-form-title">✍️ Comparte tu experiencia</div>
          <form class="review-form" onsubmit="submitReview(event, '${b.id}')">
            <div class="form-row">
              <div class="form-subgroup">
                <label>Calidad</label>
                <select name="foodQuality">
                  <option value="5">5 - Excelente</option>
                  <option value="4">4 - Bueno</option>
                  <option value="3">3 - Regular</option>
                  <option value="2">2 - Malo</option>
                  <option value="1">1 - Pésimo</option>
                </select>
              </div>
              <div class="form-subgroup">
                <label>Servicio</label>
                <select name="service">
                  <option value="5">5 - Excelente</option>
                  <option value="4">4 - Bueno</option>
                  <option value="3">3 - Regular</option>
                  <option value="2">2 - Malo</option>
                  <option value="1">1 - Pésimo</option>
                </select>
              </div>
              <div class="form-subgroup">
                <label>Precio</label>
                <select name="price">
                  <option value="5">5 - Muy Barato</option>
                  <option value="4">4 - Económico</option>
                  <option value="3">3 - Regular</option>
                  <option value="2">2 - Caro</option>
                  <option value="1">1 - Muy Caro</option>
                </select>
              </div>
            </div>
            <div class="form-group" style="margin-bottom:0;">
              <textarea name="comment" placeholder="Cuéntanos cómo fue tu experiencia... (opcional)"></textarea>
            </div>
            <button type="submit" class="btn btn-primary" style="padding:.5rem 1rem;font-size:.8rem;align-self:flex-end;">Publicar Opinión</button>
          </form>
        </div>
      </div>
    `;

    listContainer.appendChild(card);
  });
}

// ==========================================================================
// REVIEWS
// ==========================================================================
function toggleReviews(businessId) {
  const drawer = document.getElementById(`drawer-${businessId}`);
  if (drawer) drawer.classList.toggle('hidden');
}

async function submitReview(event, businessId) {
  event.preventDefault();
  const form = event.target;
  const comment = form.elements.comment.value.trim();
  const foodQuality = parseFloat(form.elements.foodQuality.value);
  const service = parseFloat(form.elements.service.value);
  const price = parseFloat(form.elements.price.value);

  try {
    const res = await fetch(`${API_BASE}/api/businesses/${businessId}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ comment, ratings: { foodQuality, service, price } })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al enviar la reseña.');

    await fetchBusinesses();

    setTimeout(() => {
      const drawer = document.getElementById(`drawer-${businessId}`);
      if (drawer) drawer.classList.remove('hidden');
    }, 150);
  } catch (err) {
    alert(err.message);
  }
}

// ==========================================================================
// RESERVAS
// ==========================================================================
function toggleReservation(businessId) {
  const drawer = document.getElementById(`reservation-${businessId}`);
  if (drawer) drawer.classList.toggle('hidden');
}

async function submitReservation(event, businessId) {
  event.preventDefault();
  const form = event.target;
  const date = form.elements.date.value;
  const time = form.elements.time.value;
  const partySize = parseInt(form.elements.partySize.value);
  const resultEl = document.getElementById(`reservation-result-${businessId}`);

  try {
    const res = await fetch(`${API_BASE}/api/businesses/${businessId}/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ date, time, partySize })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al reservar.');

    resultEl.innerHTML = `<div class="reservation-success">✅ ${escapeHtml(data.message)}</div>`;
    form.reset();
  } catch (err) {
    resultEl.innerHTML = `<div class="error-message" style="margin-top:.75rem;">${escapeHtml(err.message)}</div>`;
  }
}

function focusBusinessCard(businessId) {
  const el = document.getElementById(`card-${businessId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.borderColor = 'var(--primary)';
    el.style.boxShadow = 'var(--shadow-glow)';
    setTimeout(() => { el.style.borderColor = ''; el.style.boxShadow = ''; }, 2000);
  }
}

// ==========================================================================
// UTILS
// ==========================================================================
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
