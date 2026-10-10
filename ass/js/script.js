//
import {
    cargarSesion, pedirJWT, conectar, enviarMensaje,
    getUsuario, cerrarSesion
} from '../acces/api.js';

// --- SELECTORES DOM ---
const $ = id => document.getElementById(id);
let nombreUsuario = "";

document.addEventListener("DOMContentLoaded", () => {
    const msgsContainer = $("messages-container");
    const statusLabel = $("connection-status");
    const statusDot = $("status-dot");
    const loginScreen = $("login-screen");
    const chatInterface = $("chat-interface");
    const errorMsg = $("error-msg");
    const messageInput = $("message-input");
    const usernameInput = $("username-input");
    const passwordWrapper = $("password-wrapper");
    const passwordInput = $("password-input");
    const enterBtn = $("enter-btn");
    const messageForm = $("message-form");
    const logoutBtn = $("logout-btn");

    // ============================================================
    // DETECCIÓN DE PÁGINA: cada HTML carga el mismo script.js,
    // pero tiene elementos distintos según sea login o chat.
    // ============================================================
    const PAGINA_LOGIN = !!(loginScreen && usernameInput && enterBtn);
    const PAGINA_CHAT  = !!(chatInterface && msgsContainer);

    if (!PAGINA_LOGIN && !PAGINA_CHAT) {
        console.error("❌ Ni login ni chat: esta página no es ninguna de las dos conocidas.");
        return;
    }
    console.log(`📄 Página detectada: ${PAGINA_LOGIN ? "LOGIN" : "CHAT"}`);

    // --- UTILIDADES UI ---
    const escapeHTML = (s) => {
        const div = document.createElement("div");
        div.textContent = s;
        return div.innerHTML;
    };

    const formatTime = (dateObj) => {
        const d = dateObj ? new Date(dateObj) : new Date();
        return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
    };

    const setConnectionStatus = (state, message = "") => {
        if (!statusLabel || !statusDot) return;
        statusDot.className = 'status-dot';
        if (state === 'online') {
            statusLabel.textContent = "En línea";
            statusDot.classList.add('online');
            if (errorMsg) errorMsg.classList.remove('visible');
        } else if (state === 'offline') {
            statusLabel.textContent = "Desconectado";
            statusDot.classList.add('offline');
        } else if (state === 'connecting') {
            statusLabel.textContent = "Conectando...";
            statusDot.classList.add('connecting');
        }
        // En login no hay status dot: los errores van por mostrarError()
        if (PAGINA_LOGIN && message) mostrarError(message);
    };

    const mostrarError = (msg) => {
        if (errorMsg) {
            errorMsg.textContent = msg;
            errorMsg.classList.add('visible');
            setTimeout(() => errorMsg.classList.remove('visible'), 4000);
        } else {
            console.warn("⚠️", msg);
        }
    };

    const mostrarChat = (nombre) => {
        // Desde el login navegamos a la página real del chat:
        if (PAGINA_LOGIN) {
            window.location.href = "chat/chat.html";
            return;
        }
        // Ya estamos en chat.html (reconexión / recarga):
        const avatar = $("user-avatar");
        if (avatar && nombre) avatar.textContent = nombre[0].toUpperCase();
        chatInterface.classList.remove("hidden");
        chatInterface.style.display = "flex";
    };

    const mostrarLogin = () => {
        if (PAGINA_CHAT) {
            // La sesión murió en la página del chat → volver al login
            window.location.href = "../index.html";
            return;
        }
        loginScreen.classList.remove("hidden");
        loginScreen.style.display = "flex";
    };

    // --- RENDERIZADO DE MENSAJES (solo página chat) ---
    function agregarMensaje(quien, texto, tipo, fechaIso = null) {
        if (!msgsContainer) return;
        const div = document.createElement("div");
        const hora = formatTime(fechaIso);
        const textoSeguro = escapeHTML(texto);

        if (tipo === "sys") {
            div.className = "msg sys";
            div.innerHTML = textoSeguro;
        } else {
            div.className = `msg ${tipo}`;
            let contenidoHTML = "";
            if (tipo === "otro" && quien) contenidoHTML += `<div class="who">${escapeHTML(quien)}</div>`;
            contenidoHTML += `<div class="text">${textoSeguro}</div>`;
            contenidoHTML += `<div class="t">${hora}</div>`;
            div.innerHTML = contenidoHTML;
        }
        msgsContainer.appendChild(div);
        requestAnimationFrame(() => { msgsContainer.scrollTop = msgsContainer.scrollHeight; });
    }

    const onConnError = (e) => {
        console.error("Error de conexión:", e);
        mostrarError("Error de conexión. Reintentando...");
    };

    // Mismos nombres reservados que valida el backend (aquí solo para dar
    // feedback inmediato sin ir al servidor; el control REAL es el backend).
    const RESERVADOS = new Set([
        "admin", "administrator", "administrador", "root", "superuser", "su",
        "sysadmin", "system", "sistema", "moderator", "moderador", "mod",
        "staff", "owner", "propietario", "host", "server", "servidor",
        "webmaster", "postmaster", "support", "soporte", "guest", "invitado",
        "anonymous", "anonimo", "null", "none", "undefined", "nan",
        "console", "operator", "service", "oficial", "official", "help",
        "ayuda", "bot", "chatbot", "chat", "me", "yo", "my", "mine",
        "god", "dios",
    ]);
    const esNombreReservado = (nombre) => {
        const limpio = nombre
            .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e")
            .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
            .replace(/@/g, "a").replace(/\$/g, "s")
            .replace(/[^a-z0-9]/g, "");
        return RESERVADOS.has(limpio) || RESERVADOS.has(limpio.replace(/\d+$/, ""));
    };

    // La cuenta admin (Strellas) es la ÚNICA que pide contraseña.
    // (El control real es el backend; aquí solo se adapta la interfaz.)
    const esCuentaAdmin = (nombre) => nombre
        .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]/g, "") === "strellas";

    // Muestra/oculta el campo de contraseña según el nombre escrito.
    function actualizarCampoPassword() {
        if (!passwordWrapper) return;
        const admin = esCuentaAdmin(usernameInput.value.trim());
        passwordWrapper.hidden = !admin;
        if (!admin && passwordInput) passwordInput.value = "";
    }

    // ============================================================
    // LÓGICA DE LA PÁGINA LOGIN (index.html)
    // ============================================================
    if (PAGINA_LOGIN) {

        async function entrarAlChat() {
            const n = usernameInput.value.trim();
            if (n.length < 2) {
                mostrarError("Escribe un nombre válido (mín. 2 caracteres)");
                usernameInput.focus();
                return;
            }
            const admin = esCuentaAdmin(n);
            if (!admin && esNombreReservado(n)) {
                mostrarError("Ese nombre está reservado, elige otro");
                usernameInput.focus();
                return;
            }
            const password = admin && passwordInput ? passwordInput.value : "";
            if (admin && !password) {
                mostrarError("Introduce la contraseña de administrador");
                passwordInput.focus();
                return;
            }

            enterBtn.disabled = true;   // anti doble-click
            setConnectionStatus('connecting', "Autenticando...");

            try {
                // pedirJWT guarda JWT + deviceId + usuario en localStorage
                await pedirJWT(n, password);
                // Autenticado → saltar a la página del chat
                window.location.href = "chat/chat.html";
            } catch (e) {
                enterBtn.disabled = false;
                const msg = e.status === 401
                    ? "Clave rechazada (401): ¿fue rotada? Actualiza PUBLIC_TOKEN."
                    : e.status === 429
                        ? "Demasiados intentos (429). Espera un minuto."
                        : e.status === 403
                            ? (admin ? "Contraseña incorrecta." : "Ese nombre está reservado, elige otro.")
                            : e.status === 503
                                ? "La cuenta admin no está configurada todavía."
                                : (e.message || "Error autenticando. ¿Túnel activo?");
                mostrarError(msg);
            }
        }

        enterBtn.addEventListener("click", entrarAlChat);
        usernameInput.addEventListener("input", actualizarCampoPassword);
        usernameInput.addEventListener("keydown", e => {
            if (e.key === "Enter") {
                e.preventDefault();
                // Si aparece el campo de contraseña, Enter pasa el foco a él.
                if (passwordWrapper && !passwordWrapper.hidden && passwordInput) passwordInput.focus();
                else entrarAlChat();
            }
        });
        if (passwordInput) {
            passwordInput.addEventListener("keydown", e => {
                if (e.key === "Enter") { e.preventDefault(); entrarAlChat(); }
            });
        }
        usernameInput.focus();
        return;   // ← en el login no hay nada más que hacer
    }

    // ============================================================
    // LÓGICA DE LA PÁGINA CHAT (chat/chat.html)
    // ============================================================

    // ¿Hay sesión guardada? → conectar directamente
    cargarSesion();
    const usuarioGuardado = getUsuario();
    if (usuarioGuardado) {
        nombreUsuario = usuarioGuardado;
        mostrarChat(nombreUsuario);
        conectar(agregarMensaje, setConnectionStatus, onConnError);
    } else {
        // Sin sesión válida → mandar al login
        mostrarLogin();
    }

    function salirDelChat() {
        cerrarSesion();
        nombreUsuario = "";
        mostrarLogin();
        console.log("👋 Sesión cerrada correctamente");
    }

    if (messageForm && messageInput) {
        messageForm.addEventListener("submit", e => {
            e.preventDefault();
            const texto = messageInput.value.trim();
            if (!texto || !nombreUsuario) return;

            const mensaje = { tipo: "mensaje", usuario: nombreUsuario, contenido: texto };
            if (enviarMensaje(mensaje)) {
                agregarMensaje(nombreUsuario, texto, "yo");
                messageInput.value = "";
                messageInput.focus();
            } else {
                mostrarError("Error al enviar. Reconectando...");
                conectar(agregarMensaje, setConnectionStatus, onConnError);
            }
        });
    }
    if (logoutBtn) logoutBtn.addEventListener("click", salirDelChat);

    // Al cerrar la pestaña: logout limpio (borra el JWT guardado).
    // Consecuencia: cerrar la pestaña = cerrar sesión.
    window.addEventListener("beforeunload", cerrarSesion);
});