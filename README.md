(Gratuito, sin NGINX/Apache, HTML5 vainilla + clave creada a mano en el backend), lo óptimo es **un único proceso backend que sirva tanto los archivos estáticos (tu HTML) como la API**, para no necesitar ningún servidor web adicional.

(WEB) https://strellas.github.io/chat-GLOBAL/

---

- 1. **FastAPI es actualmente el framework ligero dominante para APIs en Python** (el más usado según las encuestas de desarrolladores 2025-2026, con validación integrada y docs automáticas), ideal para esto ([Rollbar](https://rollbar.com/blog/python-backend-frameworks), [Dualite](https://dualite.dev/blogs/python-web-framework-picks)).

- 2. **El patrón correcto es que la clave sensible viva solo en el backend**, y que el frontend envíe una credencial que el backend valida; nunca poner claves privadas de terceros en el JS público ([GitGuardian](https://blog.gitguardian.com/stop-leaking-api-keys-the-backend-for-frontend-bff-pattern-explained), [WeWeb](https://www.weweb.io/blog/securely-using-api-keys-from-a-frontend-no-code-app)).

## Arquitectura ▶️ Lánzalo tú en TU terminal (eso sí persiste)

```bash
# Backend
python -m uvicorn \
  main:app --app-dir /ChatView/servidor_backd \
  --host 127.0.0.1 --port 8000 --log-level warning

# Túnel (en otra terminal; ya tienes uno corriendo)
cloudflared tunnel run ¿?-tunnel
```

Comprobar: `curl -s http://127.0.0.1:8000/health` → `{"status":"ok",...}`
