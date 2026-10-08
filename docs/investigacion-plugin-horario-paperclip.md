# Plugin de horario y cuota para Paperclip

## Conclusión

Sí es factible crear un plugin para Paperclip que pause y reanude los agentes de acuerdo con un calendario, y que evite arrancar ejecuciones cerca de un corte de cuota. Paperclip ya ofrece el SDK oficial de TypeScript, jobs periódicos con cron, estado persistente, UI de configuración y control de agentes; los agentes se ejecutan por *heartbeats*, no como procesos permanentes.

La integración puede obtener la hora de corte desde **`/usage` de Claude Code**. La documentación actual de Anthropic indica que `/usage` muestra los límites del plan y cuándo se reinician; además, la respuesta de límite muestra la hora de reset. El plugin debe ejecutar esa consulta mediante la instalación autenticada de Claude Code que usa `claude_local`, extraer el próximo reinicio y convertirlo a un instante con zona horaria. No debe asumir que la cuota se reinicia siempre a una hora fija. Una hora configurada manualmente queda únicamente como respaldo si `/usage` falla, está temporalmente rate-limited o cambia a un formato no interpretable.

## Política propuesta

Asumo esta intención operativa:

- Entre **09:00 y 20:00**, los agentes gestionados quedan pausados para reservar la cuota para tu trabajo manual.
- Desde **20:00** hasta el próximo corte conocido, los agentes trabajan para consumir la cuota disponible.
- Antes del corte se paran con un margen de seguridad (por ejemplo, 5–15 minutos). Si el siguiente corte es **05:30**, se pausarán a las **05:20**.
- Desde 05:30 hasta 09:00 no se lanzan agentes. Así, la nueva cuota queda intacta para que tú la uses a partir de las 09:00.

Con un corte a las 05:30, el calendario diario sería:

| Intervalo local | Estado de los agentes | Motivo |
|---|---:|---|
| 20:00–05:20 | reanudados | trabajo autónomo nocturno |
| 05:20–09:00 | pausados | evitar contaminar la cuota que se reinicia a las 05:30 |
| 09:00–20:00 | pausados | reservar cuota para tu jornada |

Hay una precisión: los planes de Claude tienen límites de uso compartidos y ventanas rodantes; una hora como 05:30 es información de tu sesión/cuenta, no una regla universal. Si el límite se reinicia a las 10:30 tras comenzar a usarlo a las 05:30, el plugin debe mantener a los agentes pausados durante tu jornada; de ese modo la cuota posterior a las 10:30 también queda para ti. Al llegar las 20:00, el plugin vuelve a habilitar el trabajo nocturno.

## Qué proporciona Paperclip hoy

Paperclip tiene un sistema de plugins implementado, aunque su `PLUGIN_SPEC.md` incluye ideas futuras. Para desarrollo, la referencia fiable es `PLUGIN_AUTHORING_GUIDE.md` y el SDK `@paperclipai/plugin-sdk`.

- Un plugin tiene normalmente `src/manifest.ts`, `src/worker.ts` y, si necesita configuración visual, `src/ui/index.tsx`.
- El worker se declara con `definePlugin(...)`.
- `jobs[]` del manifiesto admite una expresión cron; el worker recibe cada ejecución con `ctx.jobs.register(jobKey, handler)`.
- El plugin puede persistir su configuración/estado con `ctx.state` y exponer una página de Settings con `usePluginData` / `usePluginAction`.
- Paperclip maneja agentes mediante heartbeats. La guía de runtime documenta los estados de ejecución, el heartbeat, las pausas y las reanudaciones. La API base del producto expone `POST /agents/:agentId/pause` y `POST /agents/:agentId/resume`.
- Para trabajo recurrente visible en el tablero, Paperclip recomienda `routines`; para mantenimiento interno como un controlador de horario, un `job` del plugin es el mecanismo apropiado.

## Diseño recomendado: `quota-schedule-guard`

### Responsabilidad acotada

El plugin no administra prompts, proyectos ni crea nuevos agentes. Solo decide si un conjunto seleccionado de agentes puede estar activo según la regla horaria. Debe usar una lista explícita de IDs de agente o un selector por compañía, nunca pausar automáticamente todos los agentes sin aprobación.

### Configuración por compañía

| Campo | Ejemplo | Uso |
|---|---|---|
| `timezone` | `America/Santiago` | Evaluar todos los horarios en la zona correcta, incluido DST |
| `workStart` | `09:00` | Inicio de tu jornada; se pausa |
| `workEnd` | `20:00` | Fin de jornada; comienza la ventana autónoma |
| `pauseLeadMinutes` | `10` | Evita iniciar/correr cerca del corte |
| `usagePollMinutes` | `15` | Frecuencia de consulta de `/usage`; no conviene hacerlo por cada reconciliación |
| `agentIds` | `["..."]` | Agentes a controlar |
| `enabled` | `true` | Interruptor global por compañía |
| `fallbackResetAt` | `05:30` | Respaldo si `/usage` no devuelve un corte usable |
| `mode` | `claude-usage` / `manual-fallback` | Fuente efectiva del siguiente corte |

El plugin debe persistir `nextResetAt` como instante UTC, junto con `usageCheckedAt`, el origen (`/usage`, error de límite o respaldo manual) y una versión/huella del parser. La UI debe mostrar tanto la hora local calculada como la antigüedad de la última lectura.

### Job del plugin

Declarar un único job de reconciliación cada minuto o cada dos minutos:

```ts
jobs: [
  {
    jobKey: "reconcile-schedule",
    displayName: "Reconciliar horario de cuota",
    description: "Pausa o reanuda los agentes configurados según el horario local.",
    schedule: "*/1 * * * *",
  },
]
```

Capacidades mínimas a confirmar contra la versión de Paperclip instalada:

- `jobs.schedule`
- `plugin.state.write`
- La capacidad de lectura/control de agentes que exija el SDK/host de esa versión.
- `instance.settings.register` y un slot `settingsPage` si se incorpora la configuración gráfica.

El worker aplica una función pura y testeable:

```text
shouldRun(nowLocal, config):
  cutoff = resetAt - pauseLeadMinutes
  if workStart <= now < workEnd:       false
  if now >= cutoff or now < workStart: false
  otherwise:                           true
```

Para el ejemplo 09:00/20:00 y reset 05:30 con 10 minutos de margen, `shouldRun` solo devuelve `true` entre 20:00 y 05:20. Debe funcionar también cuando la ventana cruza medianoche.

En cada ejecución:

1. Cargar la configuración de la compañía y convertir `now` con `timezone`.
2. Calcular el estado deseado.
3. Consultar los agentes seleccionados.
4. Si el estado ya coincide, no hacer nada.
5. Si debe detenerse, pausar solamente los que estén activos; opcionalmente cancelar un run ya activo si Paperclip expone ese control en la versión instalada y si la configuración lo permite.
6. Si debe arrancar, reanudar únicamente los pausados por este plugin. No se debe reanudar un agente que el operador pausó manualmente.
7. Persistir una marca por agente, por ejemplo `pausedBySchedule=true`, más el último motivo, para distinguir la pausa automatizada de una pausa manual.
8. Emitir una entrada de actividad/auditoría: `paused_for_work_hours`, `paused_for_reset_reserve` o `resumed_for_night_window`.

### Protección ante carreras

Pausar un agente evita futuros heartbeats, pero una ejecución que ya está en curso puede continuar. Para garantizar el corte de las 05:20:

- Configurar `timeoutSec` de los agentes por debajo del margen operativo o iniciar el corte con suficiente anticipación.
- Si el host ofrece cancelación de runs, hacerla opcional y visible en la UI; cancelar trabajo puede perder progreso.
- Reducir los heartbeats a intervalos razonables y no iniciar un heartbeat cuando falte menos que `pauseLeadMinutes + timeoutSec` para el corte.
- Ser idempotente: la reconciliación debe poder repetirse sin reanudar/pausar innecesariamente.

## Detección de la hora de reinicio con `/usage`

### Fuente primaria: Claude Code autenticado

`/usage` es la fuente primaria. Anthropic documenta que muestra los límites de uso del plan y **cuándo se reinician**. El plugin debe usar el binario `claude` y el mismo perfil autenticado que utilicen los agentes `claude_local`; un job separado de consulta actualiza `nextResetAt`, mientras el job de reconciliación aplica pausas/reanudaciones cada minuto.

La consulta no debe crear trabajo de agente ni enviar una tarea de negocio. Su único propósito es obtener el estado de cuota. La implementación debe validar que la salida contiene una hora/fecha de reinicio inequívoca, resolverla en la `timezone` configurada y guardarla en UTC. Si Claude entrega también ventanas semanales o por familia de modelo, se debe usar el reset de la **sesión compartida** para la política nocturna; un límite semanal agotado requiere mantener los agentes pausados y avisar al operador.

La documentación de costes señala que, si no hay una instantánea reciente, `/usage` puede reportar que el endpoint de uso está rate-limited. Por eso la consulta debe hacerse con poca frecuencia —por ejemplo cada 15 minutos— y usar la última lectura válida mientras no esté vencida.

### Señales secundarias y respaldo

El mensaje de límite de Claude Code también entrega la hora de reset; se usa para actualizar inmediatamente `nextResetAt` si un heartbeat alcanza el límite antes del siguiente sondeo. La configuración `fallbackResetAt` solo se usa cuando `/usage` no puede consultarse o no devuelve una fecha interpretable.

Reglas necesarias:

- Nunca registrar credenciales, prompts ni salida completa; persistir solo tipo de límite, `nextResetAt`, origen y error reducido.
- Validar la hora contra el reloj actual: un corte pasado, demasiado lejano o sin zona horaria se rechaza.
- Si el dato de `/usage` vence y tampoco funciona el respaldo, aplicar política segura: pausar agentes y notificar.
- Conservar la alternativa manual para degradación controlada, no como fuente habitual.
- No hacer scraping de `claude.ai/settings/usage`; la CLI `/usage` es la interfaz soportada para este dato.

## Flujo de desarrollo

1. Ejecutar Paperclip localmente y confirmar la versión/target:
   ```bash
   pnpm paperclipai run
   paperclipai plugin target
   ```
2. Crear el esqueleto:
   ```bash
   paperclipai plugin init @tu-scope/quota-schedule-guard --output /ruta/a/plugins
   ```
3. Instalar dependencias, observar compilación e instalar desde ruta local:
   ```bash
   cd /ruta/a/plugins/quota-schedule-guard
   pnpm install
   pnpm dev
   paperclipai plugin install /ruta/a/plugins/quota-schedule-guard
   ```
4. Implementar primero el job, el estado y pruebas unitarias de límites (`05:19`, `05:20`, `05:30`, `08:59`, `09:00`, `19:59`, `20:00`), con cambio de día y DST de `America/Santiago`.
5. Agregar Settings UI para los campos anteriores y un botón de “Reconciliar ahora” que muestre la decisión calculada antes de actuar.
6. Verificar con:
   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   paperclipai plugin inspect tu-scope.quota-schedule-guard
   ```

Para publicar, Paperclip recomienda un paquete npm; la instalación por carpeta local es para desarrollo y ejecuta código confiable localmente sin sandbox.

## Decisión de implementación

La primera versión debe usar `/usage` como reloj de cuota y un programador basado en política horaria, no un supuesto contador de tokens. Así obtiene dinámicamente el próximo corte —por ejemplo, 05:30—, pausa antes de él, evita gastar el bloque reservado antes de tu jornada y conserva un horario manual solo para fallos transitorios.

Antes de convertirlo en plugin operativo hay que confirmar en tu instalación: el adapter usado por cada agente (`claude_local` u otro), los IDs de los agentes a controlar, tu IANA timezone (probablemente `America/Santiago`) y si se debe cancelar o solo impedir nuevos heartbeats en el corte.

## Fuentes

- Paperclip, guía de autoría de plugins: https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md
- Paperclip, desarrollo local de plugins: https://github.com/paperclipai/paperclip/blob/master/doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md
- SDK oficial de Paperclip: https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/README.md
- Paperclip, runtime de agentes: https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md
- Paperclip, rutas base de pausa/reanudación: https://github.com/paperclipai/paperclip/blob/master/doc/SPEC-implementation.md
- Anthropic, modelos, uso y límites de Claude Code: https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code
- Anthropic, comando `/usage`, límites del plan y reinicios: https://code.claude.com/docs/en/costs
- Anthropic, lista oficial de comandos (`/usage`): https://code.claude.com/docs/en/commands
- Anthropic, errores de límite y hora de reinicio: https://code.claude.com/docs/en/errors
- Anthropic, seguimiento de consumo en Settings > Usage: https://support.claude.com/en/articles/9797557-usage-limit-best-practices
