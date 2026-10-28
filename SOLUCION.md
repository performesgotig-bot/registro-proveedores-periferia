# Solución del reto

## 1. Problema en una frase

El equipo administrativo debe transcribir datos y reunir soportes repetidos para cada registro de proveedor; el agente automatiza la preparación y deja la validación y firma a una persona.

## 2. Arquitectura

```text
Navegador (web/index.html)
        │ HTTP
        ▼
Express (src/server.ts) ── adaptador OpenAI (src/llm/adapter.ts)
        │                              │
        └──── herramientas Zod ────────┘
                     │
          fixtures/ (solo lectura) ── out/ (resultados y logs)
```

- Comportamiento: `agent/prompt.md`.
- Conocimiento: `src/knowledge/registro-proveedor.md`.
- Ejecución: herramientas tipadas y verificadas con Zod en `src/tools/proveedor.ts`.
- El cliente web no recibe la clave del proveedor de IA.

## 3. Ciclo del agente

El backend envía el historial y las definiciones de herramientas al adaptador OpenAI, valida los argumentos con Zod, ejecuta las herramientas y devuelve cada llamada y resultado al chat. El bucle está limitado por `MAX_TOOL_ITERATIONS`; el consumo acumulado de tokens de una sesión también se limita. Las herramientas de envío solo escriben `ENVIO-SIMULADO.md` y el backend exige confirmación explícita en el turno inmediatamente anterior.

## 4. Elección del modelo

Se eligió OpenAI con `gpt-4o-mini` como valor inicial por su soporte de llamadas a herramientas y su costo relativo bajo. El modelo es configurable mediante `OPENAI_MODEL`; la clave se lee desde `OPENAI_API_KEY` en el backend. El costo por caso depende de la longitud de las solicitudes/respuestas y de las tarifas vigentes; no se fija una cifra porque el uso real de tokens todavía no se ha medido.

## 5. Diseño del portal web

Para una integración futura se usaría automatización de navegador controlada (por ejemplo, Playwright) en una sesión supervisada. El agente podría preparar y sugerir los valores, pero la persona ingresaría credenciales y revisaría cada campo. CAPTCHA, MFA y cambios de layout pueden interrumpir la automatización y exigen intervención humana. Las credenciales se obtendrían directamente de la persona en un gestor de secretos o sesión efímera; nunca irían al repositorio, prompt ni logs. El clic final en “Enviar” siempre quedaría a cargo de la persona. En este reto, el formato portal solo produce `valores-portal.md`.

## 6. Decisiones y trade-offs

1. **Node.js y scripts npm:** se prioriza el runtime disponible en el entorno. Bun se descartó para no requerir instalar otro runtime.
2. **Interfaz HTML sin framework:** es suficiente para el chat y evita sumar compilación del frontend; se descartó React por el tamaño acotado de la UI.
3. **OpenAI por HTTP desde un adaptador propio:** reduce dependencias y mantiene separada la interfaz del proveedor; se descartó acoplar la lógica del ciclo a un SDK.
4. **Archivos como persistencia:** conserva la trazabilidad y cumple el alcance local sin una base de datos; no cubre concurrencia o almacenamiento multiusuario de producción.

## 7. Supuestos

- Se procesan los fixtures incluidos y no se modifica su contenido.
- Como no se entregan plantillas Excel/PDF binarias, los formularios de salida se construyen desde las plantillas JSON.
- Las vigencias se comparan con la fecha de ejecución.
- `out/` puede recrearse al inicio de la demo.

## 8. Cobertura

| Historia | Estado | Pendiente para producción |
|---|---|---|
| HU-1 Leer solicitud | Hecho para fixtures | Mejorar extracción de correos y plantillas reales |
| HU-2 Mapear datos | Hecho con glosario y regla tributaria | Revisión de sinónimos y equivalencias por país |
| HU-3 Generar formulario | Hecho para Excel/PDF/portal con fixtures JSON | Conservar estilos de plantillas originales |
| HU-4 Paquete para firma | Hecho con checklist, soportes y borrador | Control de acceso, firma e integración documental |
| HU-5 Errores | Parcial | Ampliar pruebas de corrupción, límites y proveedores |

La demo local ejecuta directamente las herramientas para todos los casos y se inicia con `npx ts-node demo.ts`; no se ha desplegado un enlace público.

## 9. Uso de IA

Se usó Copilot SDK en VS Code para inspeccionar el PRD, diseñar e implementar la estructura inicial, las herramientas, la interfaz y la documentación, y apoyar la verificación. No se generaron datos personales reales ni se enviaron fixtures a servicios de terceros durante la implementación. No hubo propuestas descartadas relevantes; las decisiones de dependencias y alcance se documentan arriba.

## 10. Riesgos y mitigaciones

- **Datos maestros desactualizados:** asignar un responsable de datos y validar vigencias.
- **Alucinación del modelo:** limitar afirmaciones a resultados de herramientas y probar casos faltantes/ambiguos.
- **Exposición de información:** usar secretos del backend, no registrar valores sensibles y desplegar con autenticación y controles de retención.
- **Cambios de formatos o portales:** mantener revisión humana y no automatizar el envío final.
- **Disponibilidad/costo del proveedor:** límites por sesión, timeout y manejo explícito de errores.
