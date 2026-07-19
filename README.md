# BiteRadar Perú 🇵🇪

App para descubrir huariques y restaurantes cercanos en Perú, con aforo en tiempo
real, ranking por comentarios positivos, calendario gastronómico y reservas.

## Funcionalidades nuevas en esta versión

- **Aforo en tiempo real**: cada local muestra un badge Libre / Moderado / Lleno
  que se actualiza solo, vía Socket.IO, sin recargar la página. El servidor
  simula la fluctuación cada 12s (reemplázalo por `PATCH /api/businesses/:id/aforo`
  desde un panel real del negocio cuando lo tengas).
- **Ranking por comentarios positivos**: nuevo filtro "Ordenar Por" → "Más
  Comentarios Positivos", calculado con un análisis simple de palabras clave en
  español combinado con el promedio de estrellas (`positivityScore`).
- **Reservas**: botón "Reservar Mesa" en cada card, con fecha, hora y cantidad
  de comensales. Guarda en `db.json` y emite el evento en vivo `new-reservation`.
- **Promociones y descuentos**: carrusel "🔥 Promociones y Descuentos" arriba
  del todo, más un ribbon de descuento en la foto de cada card con oferta
  activa. Se configuran editando el campo `promotion` de cada negocio en
  `db.json`.
- **Mapa con markers de colores por categoría** + leyenda debajo del mapa.
- **Buscador de dirección/distrito**: campo de texto que autocompleta usando
  Nominatim (geocoder gratuito de OpenStreetMap, sin API key).
- **Chat de ubicación de respaldo con Gemini**: si el usuario no encuentra su
  dirección buscando, puede describir dónde está en texto libre ("cerca a la
  UNI, en el Rímac") y Gemini interpreta eso a un nombre de lugar concreto,
  que luego se geocodifica con Nominatim para sacar coordenadas reales. Si no
  configuras `GEMINI_API_KEY`, esta función se desactiva sola y avisa al
  usuario que use el buscador normal — el resto de la app sigue funcionando
  igual.
- **Logo**: `public/images/logo.svg`, aplicado en el header.

## Correr en local

```bash
npm install
npm start
```

Abre `http://localhost:3000`.

## Desplegar en Render

1. Sube este proyecto a un repo de GitHub (recuerda que `node_modules` no se
   sube — ya está en `.gitignore`).
2. En [render.com](https://render.com) → **New +** → **Web Service** → conecta
   tu repo.
3. Configuración:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free está bien para probar
4. Variables de entorno (Environment → Add Environment Variable):
   - `JWT_SECRET` → pon cualquier string largo y secreto (el código ya lo lee
     con `process.env.JWT_SECRET`, si no lo defines usa un valor por defecto
     solo para desarrollo).
   - `GEMINI_API_KEY` *(opcional)* → solo si quieres activar el chat de
     ubicación con IA. Sácala gratis en [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
     Si no la configuras, esa función se apaga sola sin romper nada más.
   - `GEMINI_MODEL` *(opcional)* → por defecto usa `gemini-2.0-flash`. Solo
     cámbialo si ese modelo deja de estar disponible en tu cuenta.
5. Deploy. Render te da una URL tipo `https://tu-app.onrender.com`.

### Importante sobre `db.json` en Render

El plan gratuito de Render usa un sistema de archivos **efímero**: cada vez que
se reinicia o redeploya el servicio, `db.json` vuelve a su versión del repo (se
pierden usuarios, reseñas y reservas nuevas). Para producción real, considera
migrar a una base de datos (Render Postgres, MongoDB Atlas, etc.). Para una
demo o entrega de curso, tal como está, funciona perfecto.

### Sobre Nominatim (buscador de direcciones)

Es gratis y no necesita API key, pero su política de uso pide no pasar de ~1
solicitud por segundo y tener un tráfico moderado. Para un proyecto de curso o
una demo está perfecto. Si el proyecto crece mucho, considera un geocoder de
pago (Google Maps, Mapbox) o alojar tu propia instancia de Nominatim.

### Plan gratuito y "cold starts"

En el plan free, el servicio se duerme tras ~15 min de inactividad y tarda unos
segundos en despertar con la primera visita. Es normal, no es un error.

## Estructura

```
server.js          # Express + Socket.IO
db.json             # "base de datos" (JSON)
package.json
public/
  index.html
  app.js
  style.css
  images/
    logo.svg        # logo de BiteRadar Perú
    *.png            # fotos de categorías
```
