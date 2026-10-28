# Conocimiento del proceso de registro de proveedores

## Estados de campos

- `lleno`: existe una fuente exacta en el maestro de datos.
- `faltante`: no hay fuente; no se debe inferir ni inventar.
- `requiere_confirmacion`: hay una regla de país o ambigüedad que requiere revisión humana.

## Identificación tributaria

CO usa NIT; EC, PE y PA usan RUC; HN usa RTN. El maestro contiene únicamente el NIT colombiano. Para clientes fuera de Colombia se propone ese dato como referencia y se marca `requiere_confirmacion` con la nota `identificador extranjero`.

## Preparación y cierre

Los datos bancarios solo se incluyen cuando los solicita expresamente la plantilla, y nunca se agregan al borrador de correo. Un soporte exigido ausente o vencido bloquea el estado `listo_para_firma`; los campos faltantes se reportan, pero no bloquean por sí mismos. El agente no firma ni envía documentos.
