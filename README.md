# QuickTodo

Aplicacion de escritorio (tipo sticky note) hecha con Tauri 2 + React + TypeScript + Tailwind.

La idea es simple: una TODO app que vive en segundo plano, se abre con un hotkey global, permite capturar tareas en segundos y mantenerlas organizadas, con un look translucido nativo (Liquid Glass en macOS 26).

## Que hace

- Corre como app de escritorio ligera, viva en background con icono en la barra de menu / system tray.
- Se abre/oculta con un **hotkey global** (por defecto `Ctrl + Espacio`, configurable).
- Se enfoca el input automaticamente y `Enter` agrega una tarea.
- `Ctrl/Cmd + Enter` agrega la tarea como **importante**.
- Click en el circulo = completar (la tarea pasa a la seccion **Completed**, recuperable).
- **Tareas importantes**: suben al inicio y se marca su checkbox en rojo.
- **Reordenar** arrastrando dentro de cada seccion.
- **Focus mode** (doble click en una tarea): titulo editable, estado, fecha y descripcion con autoguardado.
- **Editar titulo**: doble click sobre el titulo en focus mode, o clic derecho > "Editar tarea".
- **Menu de clic derecho nativo** (NSMenu real en macOS): editar, copiar, importante, completar, eliminar.
- **Deshacer** al eliminar (toast de 5s).
- **Navegacion por teclado**: `↑/↓` selecciona, `Enter`/`Espacio` completa, `⌘/Ctrl + Backspace` elimina, `i` marca importante.
- **Ocultar al perder foco** (tipo Spotlight), con animacion suave de aparicion/desaparicion.
- **Redimensionar** la ventana desde cualquier borde o esquina.
- **Preferencias** (boton de engrane): hotkey configurable, iniciar con el sistema, ocultar al perder foco, exportar/importar.
- **Exportar / Importar** tareas en JSON, y exportar a Markdown.
- `Esc` oculta la ventana (o cierra el panel/edicion segun el contexto).

## Stack

- Tauri 2
- React 19
- TypeScript
- Tailwind CSS
- Rust para la logica nativa
- [`tauri-plugin-liquid-glass`](https://github.com/hkandala/tauri-plugin-liquid-glass) para el material Liquid Glass nativo en macOS 26+

## Hotkey global

Por defecto registra `Ctrl + Espacio`. Si esta ocupado, cae a `Alt/Option + Espacio`.

Desde **Preferencias** puedes elegir entre varios presets: `Ctrl+Space`, `Option+Space`, `Cmd+Shift+Space`, `Ctrl+M`. El atajo activo se aplica al instante y se recuerda.

## Apariencia (Liquid Glass)

En **macOS 26 (Tahoe)** la ventana usa `NSGlassEffectView` nativo (Liquid Glass real) por detras de un webview transparente. En sistemas anteriores cae automaticamente a vibrancy clasico (`NSVisualEffectView`). El radio, el tinte y la variante se configuran desde el frontend (`setLiquidGlassEffect`).

## Persistencia

Las tareas se guardan en un archivo JSON dentro del directorio de datos de la app.

- **Escritura atomica** (archivo temporal + rename): un corte a mitad de guardado nunca deja el JSON a medias.
- **Respaldo** `tasks.bak` antes de cada guardado.
- Si `tasks.json` se corrompe, intenta recuperar desde `tasks.bak` y guarda el dañado en `tasks.corrupt.json` para no perder datos.

Las preferencias se guardan en `settings.json`.

## Requisitos para desarrollo

- Node.js + npm
- Rust (rustup) + toolchain estable
- macOS: Xcode Command Line Tools (`xcode-select --install`). No necesita WebView2 (eso es solo Windows).

## Instalacion local

```bash
npm install
```

## Desarrollo

```bash
npm run tauri:dev
```

Levanta Vite en `http://localhost:1420` y abre la app Tauri conectada al frontend en modo dev. Cambios en el frontend recargan al instante; cambios en Rust (`src-tauri/src/lib.rs`) recompilan la parte nativa.

Comandos utiles:

```bash
npm run dev            # solo frontend
npm run build          # build web (tsc + vite)
cd src-tauri && cargo check   # chequeo del backend Rust
```

## Build

```bash
npm run tauri:build
```

En macOS genera la app y el instalador en:

- `src-tauri/target/release/bundle/macos/TODO.app`
- `src-tauri/target/release/bundle/dmg/TODO_<version>_aarch64.dmg`

Para Macs Intel: `rustup target add x86_64-apple-darwin` y `npm run tauri:build -- --target x86_64-apple-darwin`.

> La app no esta firmada/notarizada. La primera vez macOS puede bloquearla: usa "Abrir de todos modos" en Ajustes del Sistema > Privacidad y Seguridad, o `xattr -dr com.apple.quarantine /ruta/a/TODO.app`.

## Estructura del proyecto

```text
TODOApp/
  src/
    App.tsx              # UI principal: captura, lista, focus mode, teclado, preferencias
    main.tsx             # bootstrap React
    styles.css           # Tailwind + estilos del glass
  src-tauri/
    src/
      lib.rs             # hotkey, tray, persistencia, menu nativo, settings, resize, comandos
      main.rs            # entrada nativa
    capabilities/        # permisos Tauri
    tauri.conf.json      # ventana, build, bundle
  package.json
  vite.config.ts
  tailwind.config.ts
```

## Archivos clave

- UI / experiencia: `src/App.tsx`, `src/styles.css`, `tailwind.config.ts`
- Ventana / bundle: `src-tauri/tauri.conf.json`
- Hotkey, tray, persistencia, menu nativo, settings, resize: `src-tauri/src/lib.rs`

## Filosofia del proyecto

Una utilidad rapida, pequeña y enfocada. Cada cambio deberia favorecer ligereza, rapidez de uso y simplicidad.
```
