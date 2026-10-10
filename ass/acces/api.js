// CAPA DE COMUNICACIÓN: conexión, auth, WebSocket.

/**
 * API Client & WebSocket Manager
 * Autenticación, conexión WS y comunicación con el backend.
 *
 * ⚠️ NOTA DE SEGURIDAD: cualquier valor en un .js público es visible para
 * cualquiera que abra DevTools. Si esta key es sensible, genérala por sesión. 
 * Está aquí porque tu arquitectura actual la espera como header/param.
 */

// --- CONFIGURACIÓN ---
// ⚠️ Token público = contenido EXACTO de claves/active.key en el BKN.
// La defensa
// real es el rate-limit por IP, la huella did/UA y la expiración corta del JWT.
const TUNEL = {
    // ✅ Túnel NOMBRADO permanente: esta URL ya NO cambia al reiniciar cloudflared
    BASE_HTTP: "https://chat.archivoscloud.site",
    WS_URL: "wss://chat.archivoscloud.site/ws/chat",
};
const LOCAL = {
    BASE_HTTP: "http://127.0.0.1:8000",
    WS_URL: "ws://127.0.0.1:8000/ws/chat",
};

// Preview local (localhost/127.0.0.1) → backend local; producción → túnel.
// Así ves los cambios al instante sin subir a GitHub en cada iteración.
const API_CONFIG = {
    ...(["localhost", "127.0.0.1"].includes(location.hostname) ? LOCAL : TUNEL),
    PUBLIC_TOKEN: "48b4552a990051139bd6170e519b2002096aba477e9a21053dde50d368ff8238"
};

// --- ESTADO INTERNO ---
let ws = null;
let jwt = null;
let deviceId = null;
let nombreUsuario = "";
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let sesionCerrada = false;
const MAX_RECONNECT_ATTEMPTS = 10;

const STORAGE_KEYS = {
    DEVICE_ID: "chat_device_id",
    JWT: "chat_jwt_token",
    USERNAME: "chat_username"
};

// --- SONIDO E ICONO (carga perezosa) ---
let soundNotification = null;
let iconoNotificacion = null;
try {
    const audioSrc = new URL("../sfx/pop.mp3", import.meta.url).href;
    soundNotification = new Audio(audioSrc);

    const iconSrc = new URL("../img/avatar.png", import.meta.url).href;
    fetch(iconSrc, { method: "HEAD" })
        .then(r => { if (r.ok) iconoNotificacion = iconSrc; })
        .catch(() => {});
} catch (e) {
    console.debug("Recursos multimedia no encontrados o bloqueados (normal en desarrollo).");
}

// --- GESTIÓN DE SESIÓN ---
export function cargarSesion() {
    try {
        deviceId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID) || null;
        jwt = localStorage.getItem(STORAGE_KEYS.JWT) || null;
        nombreUsuario = localStorage.getItem(STORAGE_KEYS.USERNAME) || "";
        sesionCerrada = false;
    } catch (e) {
        deviceId = null;
        jwt = null;
        nombreUsuario = "";
    }
}

function guardarSesion() {
    try {
        if (deviceId) localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
        if (jwt) localStorage.setItem(STORAGE_KEYS.JWT, jwt);
        if (nombreUsuario) localStorage.setItem(STORAGE_KEYS.USERNAME, nombreUsuario);
    } catch (e) { /* storage bloqueado */ }
}

function limpiarSesion() {
    try {
        localStorage.removeItem(STORAGE_KEYS.JWT);
        localStorage.removeItem(STORAGE_KEYS.USERNAME);
        // deviceId SE CONSERVA para identificar el dispositivo en futuras sesiones
    } catch (e) { /* storage bloqueado */ }
    jwt = null;
    nombreUsuario = "";
}

// --- AUTENTICACIÓN ---
export async function pedirJWT(usuario) {
    nombreUsuario = usuario;

    // Validación rápida de configuración
    if (API_CONFIG.PUBLIC_TOKEN === "***" || API_CONFIG.PUBLIC_TOKEN.length < 10) {
        throw new Error("Falta configurar PUBLIC_TOKEN en api.js");
    }

    const headers = { "Content-Type": "application/json", "X-API-Key": API_CONFIG.PUBLIC_TOKEN };
    if (deviceId) headers["X-Device-ID"] = deviceId;

    const r = await fetch(`${API_CONFIG.BASE_HTTP}/auth`, {
        method: "POST",
        headers,
        body: JSON.stringify({ usuario })
    });

    if (!r.ok) {
        if (r.status === 429) {
            const e = new Error("Demasiados intentos de auth (429). Espera un minuto.");
            e.status = 429;
            throw e;
        }
        const errData = await r.json().catch(() => ({}));
        const e = new Error(errData.error || errData.detail || `Auth falló: ${r.status}`);
        e.status = r.status;
        throw e;
    }

    const data = await r.json();
    jwt = data.access_token;
    if (data.device_id) {
        deviceId = data.device_id;
    }
    guardarSesion();
    return jwt;
}

// --- LOGOUT LIMPIO ---
export function cerrarSesion() {
    sesionCerrada = true;      // Bloquea reconexiones automáticas
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    cerrarSocketInterno();
    limpiarSesion();
}

// --- NOTIFICACIONES (uso interno) ---
async function solicitarNotificaciones() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
        try {
            await Notification.requestPermission();
        } catch (e) { /* permiso bloqueado */ }
    }
}

function enviarNotificacion(usuario, contenido) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.hidden) {
        const opciones = { body: contenido };
        if (iconoNotificacion) opciones.icon = iconoNotificacion;
        new Notification(`${usuario} dice:`, opciones);
    }
}

function reproducirSonido() {
    if (soundNotification && document.hidden) {
        try {
            soundNotification.currentTime = 0;
            soundNotification.play().catch(() => {});
        } catch (e) { /* sonido no disponible */ }
    }
}

// --- CONEXIÓN WEBSOCKET ---
export function conectar(onMessage, onStatusChange, onError) {
    if (sesionCerrada) return;
    if (isConnecting) return;
    if (ws && ws.readyState === WebSocket.OPEN) return;

    // Sin token pero con usuario conocido → pedir uno nuevo y conectar
    if (!jwt && nombreUsuario) {
        pedirJWT(nombreUsuario)
            .then(() => iniciarConexion(onMessage, onStatusChange, onError))
            .catch((e) => {
                if (e.status === 401) onStatusChange('offline', "Clave rechazada (401). ¿Se rotó la clave?");
                else if (e.status === 429) onStatusChange('offline', e.message);
                else onStatusChange('offline', "Sin red o backend caído");
                if (onError) onError(e);
            });
        return;
    }

    if (!jwt) {
        onStatusChange('offline', "Sin token de autenticación");
        if (onError) onError(new Error("No hay token"));
        return;
    }

    iniciarConexion(onMessage, onStatusChange, onError);
}

function iniciarConexion(onMessage, onStatusChange, onError) {
    isConnecting = true;
    sesionCerrada = false;
    onStatusChange('connecting');

    cerrarSocketInterno();

    // Construcción segura de la URL del WS
    const wsUrl = `${API_CONFIG.WS_URL}?token=${encodeURIComponent(jwt)}&did=${encodeURIComponent(deviceId || "")}`;

    const socket = new WebSocket(wsUrl);
    ws = socket;

    // Timeout del handshake — un WS que nunca abre (túnel caído a medias)
    // dejaba la conexión colgada como 'connecting' para siempre.
    const handshakeTimeout = setTimeout(() => {
        if (ws === socket && socket.readyState === WebSocket.CONNECTING) {
            try { socket.close(); } catch (e) {}
        }
    }, 15000);

    socket.onopen = () => {
        if (ws !== socket) { try { socket.close(); } catch(e){} return; }
        clearTimeout(handshakeTimeout);
        console.log("✅ WebSocket abierto");
        isConnecting = false;
        reconnectAttempts = 0;
        onStatusChange('online');
        socket.send(JSON.stringify({ tipo: "union", usuario: nombreUsuario }));
        solicitarNotificaciones();
    };

    socket.onmessage = (ev) => {
        if (ws !== socket) return;
        try {
            const data = JSON.parse(ev.data);

            // Responder al ping del servidor con un pong.
            // El ping del servidor ya mantiene vivo el enlace con Cloudflare,
            // pero responder genera tráfico en AMBAS direcciones, que es lo que
            // algunos intermediarios (y el propio CF) cuentan como "actividad".
            if (data.tipo === "ping") {
                socket.send(JSON.stringify({ tipo: "pong" }));
                return;
            }
            if (data.tipo === "aviso") {
                onMessage(null, `⚠️ ${data.contenido}`, "sys");
                return;
            }
            if (data.tipo === "historial") {
                // Distinguir tus propios mensajes al recargar (si no, se ven como "otro")
                onMessage(data.usuario, data.contenido,
                    data.usuario === nombreUsuario ? "yo" : "otro", data.fecha);
            } else if (data.tipo === "sistema") {
                // Los mensajes del sistema se muestran en el chat
                // ("Bienvenido, X. En línea: N") en vez de solo consola
                onMessage(null, data.mensaje, "sys");
                if (data.nombre_repetido) {
                    onMessage(null, "⚠️ Hay otra persona con tu mismo nombre. Podéis aparecer igual en la lista.", "sys");
                }
            } else if (data.tipo === "union") {
                if (data.usuario !== nombreUsuario)
                    onMessage(null, `${data.usuario} se ha unido al chat`, "sys");
            } else if (data.tipo === "mensaje") {
                if (data.usuario !== nombreUsuario) {
                    onMessage(data.usuario, data.contenido, "otro");
                    reproducirSonido();
                    enviarNotificacion(data.usuario, data.contenido);
                }
            }
        } catch (e) {
            console.warn("Mensaje no válido:", ev.data);
        }
    };

    socket.onclose = (event) => {
        if (ws !== socket) return;
        clearTimeout(handshakeTimeout);
        isConnecting = false;
        ws = null;

        if (!nombreUsuario || sesionCerrada) return; // logout manual: no reintentar

        const rechazoHuella = (event.code === 4002);
        const tokenCaducado = (event.code === 4001);
        // Si Cloudflare o el navegador informan 1006 (cierre anormal),
        // tratamos también ese caso como posible token muerto al reintento
        // final, porque algunos proxies no propagan códigos custom 4xxx.
        const cierreAnormal = (event.code === 1006);
        const renovar = rechazoHuella || tokenCaducado || (cierreAnormal && reconnectAttempts >= 2);

        // Renovar credenciales ANTES de reintentar.
        if (rechazoHuella) {
            try { localStorage.removeItem(STORAGE_KEYS.DEVICE_ID); } catch(e){}
            deviceId = null;
            jwt = null;
            console.warn("🚨 Sesión rechazada por huella. Renovando identidad...");
        } else if (tokenCaducado || (cierreAnormal && renovar)) {
            jwt = null; // JWT expirado/invalidado → pedir otro silenciosamente
            console.info("🕒 JWT posiblemente expirado. Renovando silenciosamente...");
        }

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            onStatusChange('offline', "Demasiados intentos. Recarga la página.");
            if (onError) onError(new Error("Máximo intentos alcanzado"));
            return;
        }

        reconnectAttempts++;
        // Backoff exponencial: 1s, 2s, 4s... máx 30s
        const espera = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
        const razon = rechazoHuella ? "Renovando identidad..."
                      : renovar ? "Renovando token..."
                      : "Reconectando...";
        onStatusChange('connecting', razon);

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            conectar(onMessage, onStatusChange, onError);
        }, espera);
    };

    socket.onerror = () => {
        if (ws !== socket) return;
        console.error("⚠️ Error de WebSocket");
        if (onError) onError(new Error("Error en WebSocket"));
    };
}

// --- CIERRE INTERNO DE SOCKET ---
function cerrarSocketInterno() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch (e) { /* ya estaba cerrando */ }
    ws = null;
}

// --- ENVÍO DE MENSAJES ---
export function enviarMensaje(mensaje) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(mensaje));
            return true;
        } catch (e) { return false; }
    }
    return false;
}

// --- UTILIDADES ---
export function getUsuario() { return nombreUsuario; }