# QuickTodo

Aplicacion de escritorio para Windows hecha con Tauri + React + TypeScript + Tailwind.

La idea es simple: una TODO app tipo sticky note que vive en segundo plano, se abre con un hotkey global, permite capturar tareas en segundos y elimina permanentemente una tarea al marcarla como completada.

## Que hace

- Corre como app de escritorio ligera.
- Vive en background con icono en system tray.
- Abre una ventana compacta con hotkey global.
- Enfoca el input automaticamente al mostrarse.
- `Enter` agrega una tarea nueva.
- Click en una tarea = completada y borrada para siempre.
- Guarda solo tareas pendientes en almacenamiento local.
- `Esc` oculta la ventana.

## Stack

- Tauri 2
- React 19
- TypeScript
- Tailwind CSS
- Rust para la logica nativa

## Flujo de uso

1. La app arranca y queda viva en segundo plano.
2. Presionas `Ctrl + M`.
3. Aparece una ventana pequena, centrada y enfocada.
4. Escribes una tarea.
5. Presionas `Enter`.
6. La tarea se guarda y queda visible en la lista.
7. Cuando haces click sobre una tarea, se elimina definitivamente.
8. `Esc` oculta la ventana.
9. Puedes volver a abrirla con el hotkey o desde el tray.

## Hotkey global

Por defecto intenta registrar:

- `Ctrl + M`

Si Windows o alguna otra app ya lo esta usando, hace fallback automatico a:

- `Alt + Space`

El atajo activo se muestra en la esquina superior derecha de la UI.

La logica esta en [src-tauri/src/lib.rs](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/src/lib.rs).

## Persistencia

No se usa base de datos pesada.

Las tareas pendientes se guardan en un archivo JSON dentro del directorio de datos de la aplicacion de Tauri. La ruta exacta depende del sistema, pero en Windows vive dentro del `AppData` del usuario bajo el identificador de la app.

Cada tarea tiene:

- `id`
- `text`
- `createdAt`

No hay historial de completadas, papelera ni categorias.

## Estructura del proyecto

```text
TODOApp/
  src/
    App.tsx              # UI principal, captura, lista, foco, eventos
    main.tsx             # bootstrap React
    styles.css           # Tailwind + estilos globales
  src-tauri/
    src/
      lib.rs             # hotkey global, tray, persistencia, comandos
      main.rs            # entrada nativa
    capabilities/
      desktop.json       # permisos Tauri desktop
    tauri.conf.json      # ventana, build, bundle
  package.json
  vite.config.ts
  tailwind.config.ts
```

## Requisitos para desarrollo

Necesitas tener instalado:

- Node.js
- npm
- Rust
- Visual Studio Build Tools para compilar en Windows
- WebView2 Runtime de Microsoft

Si ya pudiste correr `cargo` y `npm`, normalmente ya tienes lo principal.

## Instalacion local

```bash
npm install
```

## Desarrollo

Para desarrollo normal usa:

```bash
npm run tauri:dev
```

Eso hace dos cosas:

- levanta Vite en `http://localhost:1420`
- abre la app Tauri conectada al frontend en modo dev

### Como ir viendo cambios

Si cambias frontend:

- archivos en [src/App.tsx](/C:/Users/winte/Desktop/Programacion/TODOApp/src/App.tsx)
- archivos en [src/styles.css](/C:/Users/winte/Desktop/Programacion/TODOApp/src/styles.css)

Vite recarga casi al instante.

Si cambias backend Rust:

- archivo en [src-tauri/src/lib.rs](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/src/lib.rs)

Tauri recompila la parte nativa. Ese ciclo es mas lento que el del frontend, pero sigue siendo razonable.

### Comandos utiles durante desarrollo

Levantar solo el frontend:

```bash
npm run dev
```

Build web solamente:

```bash
npm run build
```

Chequeo del backend Rust:

```bash
cd src-tauri
cargo check
```

## Build para Windows

Para generar el ejecutable e instaladores:

```bash
npm run tauri:build
```

Esto compila:

- frontend de produccion
- binario nativo de Tauri
- instaladores para Windows

Los artefactos salen en:

- [src-tauri/target/release/app.exe](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/target/release/app.exe)
- [src-tauri/target/release/bundle/nsis](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/target/release/bundle/nsis)
- [src-tauri/target/release/bundle/msi](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/target/release/bundle/msi)

En este proyecto ya se validaron ambos:

- instalador `.exe` con NSIS
- instalador `.msi`

## Como funciona internamente

### Frontend

El frontend hace tres cosas principales:

1. Carga tareas persistidas al iniciar.
2. Guarda tareas nuevas al crear.
3. Elimina del estado y del almacenamiento cuando completas una tarea.

Tambien escucha un evento nativo para volver a enfocar el input cuando la ventana aparece por hotkey o tray.

### Backend Tauri

La parte Rust hace lo siguiente:

- registra el hotkey global
- crea el tray icon
- muestra/oculta la ventana principal
- expone comandos a React para cargar y guardar tareas
- guarda el JSON en disco

## Archivos clave para tocar segun lo que quieras cambiar

### Cambiar UI o experiencia visual

- [src/App.tsx](/C:/Users/winte/Desktop/Programacion/TODOApp/src/App.tsx)
- [src/styles.css](/C:/Users/winte/Desktop/Programacion/TODOApp/src/styles.css)
- [tailwind.config.ts](/C:/Users/winte/Desktop/Programacion/TODOApp/tailwind.config.ts)

### Cambiar comportamiento de ventana

- [src-tauri/tauri.conf.json](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/tauri.conf.json)

Aqui puedes ajustar:

- tamano
- transparencia
- decoraciones
- always on top
- posicion inicial
- si aparece en taskbar o no

### Cambiar hotkey, tray o persistencia

- [src-tauri/src/lib.rs](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/src/lib.rs)

Busca especialmente:

- `PRIMARY_SHORTCUT_LABEL`
- `FALLBACK_SHORTCUT_LABEL`
- `register_shortcut`
- `toggle_main_window`
- `load_tasks`
- `save_tasks`

## Notas de comportamiento

- Completar una tarea la borra definitivamente.
- Cerrar la ventana no mata el proceso; la oculta para mantener el flujo rapido.
- El tray tiene acciones para mostrar/ocultar y salir.
- La ventana no esta pensada como dashboard, sino como quick capture.

## Problemas comunes

### El hotkey no responde

Posibles causas:

- otra app ya esta usando `Ctrl + M`
- Windows capturo ese atajo
- la app cayo a `Alt + Space`

Revisa el indicador del atajo en la UI para ver cual quedo activo.

### La app compila pero no abre bien

Verifica:

- que `npm run tauri:dev` este levantando Vite en `1420`
- que Rust este instalado correctamente
- que WebView2 este presente en Windows

### Quiero cambiar el tamano de la ventana

Edita [src-tauri/tauri.conf.json](/C:/Users/winte/Desktop/Programacion/TODOApp/src-tauri/tauri.conf.json) y modifica:

- `width`
- `height`
- `minWidth`
- `minHeight`

## Decisiones tecnicas

- Tauri en lugar de Electron para mantener bajo consumo y binario mas ligero.
- JSON local para persistencia por simplicidad y robustez.
- Tray + hotkey global para priorizar acceso inmediato.
- UI minima, sin paneles extra ni navegacion innecesaria.

## Siguiente iteracion natural

Si quieres seguir desarrollandola, las mejoras mas razonables sin romper la simplicidad serian:

- hacer configurable el hotkey desde archivo o UI minima
- soportar click fuera para ocultar ventana
- animacion nativa mas refinada al mostrar/ocultar
- autoarranque con Windows

## Filosofia del proyecto

No sobre-ingenierices la solucion.
Esta app debe seguir siendo una utilidad rapida, pequena y enfocada.
Cada cambio deberia favorecer ligereza, rapidez de uso y simplicidad.
