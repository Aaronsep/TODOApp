import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type Task = {
  id: string;
  text: string;
  createdAt: string;
};

const appWindow = getCurrentWebviewWindow();

function createTask(text: string): Task {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
  };
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ready, setReady] = useState(false);
  const [panelSeed, setPanelSeed] = useState(0);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        const storedTasks = await invoke<Task[]>("load_tasks");

        if (!mounted) {
          return;
        }

        setTasks(storedTasks);
      } catch (error) {
        console.error("Failed to bootstrap app", error);
      } finally {
        if (mounted) {
          setReady(true);
          window.setTimeout(() => inputRef.current?.focus(), 40);
        }
      }
    };

    const bindWindowEvents = async () => {
      const unlistenFocus = await listen("quick-focus", () => {
        setPanelSeed((value) => value + 1);
        window.setTimeout(() => inputRef.current?.focus(), 20);
      });

      const unlistenClose = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        await appWindow.hide();
      });

      return () => {
        unlistenFocus();
        unlistenClose();
      };
    };

    const cleanupPromise = bindWindowEvents();
    void bootstrap();

    return () => {
      mounted = false;
      void cleanupPromise.then((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        await appWindow.hide();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const persistTasks = async (nextTasks: Task[]) => {
    setTasks(nextTasks);

    try {
      await invoke("save_tasks", { tasks: nextTasks });
    } catch (error) {
      console.error("Failed to save tasks", error);
    }
  };

  const addTask = async () => {
    const text = draft.trim();
    if (!text) {
      return;
    }

    const nextTasks = [createTask(text), ...tasks];
    setDraft("");
    await persistTasks(nextTasks);
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  const removeTask = async (taskId: string) => {
    const nextTasks = tasks.filter((task) => task.id !== taskId);
    await persistTasks(nextTasks);
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  const taskCountLabel =
    tasks.length === 1 ? "1 pendiente" : `${tasks.length} pendientes`;

  return (
    <main className="h-screen w-screen overflow-hidden rounded-[30px] bg-transparent text-slate-100">
      <section
        key={panelSeed}
        className="flex h-full w-full animate-panel-in flex-col overflow-hidden rounded-[30px] border border-[#646b79]/55 bg-[linear-gradient(180deg,rgba(22,28,40,0.62)_0%,rgba(17,22,32,0.58)_52%,rgba(13,17,24,0.64)_100%)] shadow-note backdrop-blur-[68px]"
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
          <div
            onMouseDown={(event) => {
              if (event.button === 0) {
                event.preventDefault();
                void invoke("start_window_drag");
              }
            }}
            className="flex-1 cursor-move select-none"
          >
            <p className="text-[10px] uppercase tracking-[0.36em] text-white/30">
              Quick capture
            </p>
            <h1 className="mt-2 text-[2rem] font-semibold tracking-[-0.04em] text-white">
              QuickTodo
            </h1>
          </div>
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void invoke("hide_current_window");
            }}
            className="mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#f5be4f] shadow-[0_0_0_1px_rgba(0,0,0,0.18)_inset]"
            aria-label="Ocultar ventana"
            title="Ocultar"
          >
            <span className="pointer-events-none block h-[5px] w-[5px] rounded-full bg-[#8b5b00]/50" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
        <label className="mb-4 block">
          <span className="sr-only">Nueva tarea</span>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addTask();
              }
            }}
            placeholder="Escribe una tarea y presiona Enter"
            className="w-full rounded-[22px] border border-[#5f6674]/45 bg-white/[0.045] px-4 py-4 text-base text-white outline-none transition placeholder:text-white/26 focus:border-[#f5be4f]/42 focus:bg-white/[0.06] focus:ring-2 focus:ring-[#f5be4f]/10"
            autoComplete="off"
            autoCapitalize="sentences"
            autoCorrect="on"
          />
        </label>

        <div className="mb-3 flex items-center justify-between text-xs text-white/40">
          <span>{taskCountLabel}</span>
          <span>Esc oculta</span>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {ready && tasks.length === 0 ? (
            <div className="rounded-[22px] border border-dashed border-[#5f6674]/38 bg-black/10 px-4 py-6 text-center text-sm text-white/38">
              Sin pendientes. Captura la siguiente y sigue.
            </div>
          ) : null}

          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => void removeTask(task.id)}
              className="group flex w-full animate-item-in items-center gap-3 rounded-[22px] border border-[#667080]/48 bg-white/[0.03] px-3 py-3 text-left transition hover:border-[#7d8695]/55 hover:bg-white/[0.05]"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#6b7382]/45 bg-black/20 text-[10px] text-transparent transition group-hover:border-[#f5be4f]/55 group-hover:bg-[#f5be4f]/12 group-hover:text-[#f5be4f]">
                ✓
              </span>
              <span className="flex-1 text-sm leading-6 text-white/88">
                {task.text}
              </span>
            </button>
          ))}
        </div>
        </div>
      </section>
    </main>
  );
}
