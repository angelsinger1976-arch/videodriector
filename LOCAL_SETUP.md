# Guía de Configuración Local (localhost)

Para ejecutar esta aplicación en tu propia computadora, sigue estos pasos:

## 1. Requisitos Previos
- Tener instalado **Node.js** (versión 18 o superior).
- Tener una cuenta de **Firebase** (opcional para guardar proyectos, pero recomendado).
- Tener una **Gemini API Key** (puedes obtenerla gratis en [aistudio.google.com](https://aistudio.google.com/app/apikey)).

## 2. Instalación
1. Descarga o clona el código de tu repositorio de GitHub.
2. Abre una terminal en la carpeta del proyecto.
3. Instala las dependencias:
   ```bash
   npm install
   ```

## 3. Configuración de Variables de Entorno
Crea un archivo llamado `.env` en la raíz del proyecto y añade tu clave de API:
```env
VITE_GEMINI_API_KEY="TU_CLAVE_AQUÍ"
```
*(Nota: En local usamos el prefijo `VITE_` para que React pueda acceder a ella).*

## 4. Configuración de Firebase (Login)
Si quieres que el inicio de sesión funcione en `localhost`:
1. Ve a tu [Consola de Firebase](https://console.firebase.google.com/).
2. Entra en **Authentication** -> **Settings** -> **Authorized domains**.
3. Haz clic en **Add domain** y escribe `localhost`.

## 5. Ejecución
Inicia el servidor de desarrollo:
```bash
npm run dev
```
La aplicación estará disponible en `http://localhost:3000`.

---
*Desarrollado por thefirm media studios & Google AI Studio.*
