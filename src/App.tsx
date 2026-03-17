import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type Task = {
  id: string;
  text: string;
  createdAt: string;
  completed: boolean;
  important: boolean;
};

const appWindow = getCurrentWebviewWindow();

type TaskSection = "pending" | "completed";
type ContextMenuState = {
  taskId: string;
  x: number;
  y: number;
} | null;

function createTask(text: string): Task {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
    completed: false,
    important: false,
  };
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ready, setReady] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [completedCollapsed, setCompletedCollapsed] = useState(false);

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
        window.setTimeout(() => inputRef.current?.focus(), 20);
      });

      const unlistenClose = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        await invoke("hide_current_window");
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
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        event.preventDefault();
        await invoke("hide_current_window");
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      setContextMenu(null);
    };

    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("blur", () => setContextMenu(null), { once: true });

    return () => {
      window.removeEventListener("mousedown", closeMenu);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!draggingTaskId) {
      return;
    }

    const stopDragging = () => setDraggingTaskId(null);

    window.addEventListener("mouseup", stopDragging);

    return () => {
      window.removeEventListener("mouseup", stopDragging);
    };
  }, [draggingTaskId]);

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

    const newTask = createTask(text);
    const importantTasks = pendingTasks.filter((task) => task.important);
    const regularTasks = pendingTasks.filter((task) => !task.important);
    const nextPendingTasks = [...importantTasks, newTask, ...regularTasks];
    const nextTasks = rebuildTasks(nextPendingTasks, completedTasks);
    setDraft("");
    await persistTasks(nextTasks);
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  const pendingTasks = tasks.filter((task) => !task.completed);
  const completedTasks = tasks.filter((task) => task.completed);

  const sortPendingTasks = (nextPendingTasks: Task[]) => {
    const importantTasks = nextPendingTasks.filter((task) => task.important);
    const regularTasks = nextPendingTasks.filter((task) => !task.important);
    return [...importantTasks, ...regularTasks];
  };

  const rebuildTasks = (nextPendingTasks: Task[], nextCompletedTasks: Task[]) => {
    return [...sortPendingTasks(nextPendingTasks), ...nextCompletedTasks];
  };

  const deleteTask = async (taskId: string) => {
    const nextTasks = tasks.filter((task) => task.id !== taskId);
    setContextMenu(null);
    await persistTasks(nextTasks);
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  const markTaskAsCompleted = async (taskId: string) => {
    const pendingTask = pendingTasks.find((task) => task.id === taskId);
    if (!pendingTask) {
      return;
    }

    const nextPendingTasks = pendingTasks.filter((task) => task.id !== taskId);
    const nextCompletedTasks = [
      ...completedTasks,
      {
        ...pendingTask,
        completed: true,
        important: false,
      },
    ];

    setContextMenu(null);
    await persistTasks(rebuildTasks(nextPendingTasks, nextCompletedTasks));
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  const toggleTaskImportant = async (taskId: string) => {
    const task = pendingTasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    let nextPendingTasks: Task[];

    if (task.important) {
      nextPendingTasks = pendingTasks.map((item) =>
        item.id === taskId ? { ...item, important: false } : item,
      );
    } else {
      const remainingTasks = pendingTasks.filter((item) => item.id !== taskId);
      const importantTasks = remainingTasks.filter((item) => item.important);
      const regularTasks = remainingTasks.filter((item) => !item.important);
      nextPendingTasks = [
        { ...task, important: true },
        ...importantTasks,
        ...regularTasks,
      ];
    }

    setContextMenu(null);
    await persistTasks(rebuildTasks(nextPendingTasks, completedTasks));
  };

  const copyTaskText = async (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    try {
      await navigator.clipboard.writeText(task.text);
    } catch (error) {
      console.error("Failed to copy task text", error);
    } finally {
      setContextMenu(null);
    }
  };

  const reorderSection = async (
    section: TaskSection,
    draggedTaskId: string,
    targetTaskId: string | null,
  ) => {
    const sectionTasks = section === "pending" ? pendingTasks : completedTasks;
    const fromIndex = sectionTasks.findIndex((task) => task.id === draggedTaskId);
    if (fromIndex === -1) {
      return;
    }

    const toIndex =
      targetTaskId === null
        ? sectionTasks.length - 1
        : sectionTasks.findIndex((task) => task.id === targetTaskId);

    if (toIndex === -1 || fromIndex === toIndex) {
      return;
    }

    const reorderedSectionTasks = moveItem(sectionTasks, fromIndex, toIndex);
    const nextTasks =
      section === "pending"
        ? rebuildTasks(reorderedSectionTasks, completedTasks)
        : rebuildTasks(pendingTasks, reorderedSectionTasks);

    await persistTasks(nextTasks);
  };

  const taskCountLabel =
    pendingTasks.length === 1 ? "1 pendiente" : `${pendingTasks.length} pendientes`;

  const contextTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;

  const renderTaskList = (section: TaskSection, sectionTasks: Task[]) => (
    <div className="space-y-2">
      {sectionTasks.map((task) => (
        <div
          key={task.id}
          onMouseDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            if (event.target instanceof HTMLElement && event.target.closest("button")) {
              return;
            }
            setDraggingTaskId(task.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              taskId: task.id,
              x: event.clientX,
              y: event.clientY,
            });
          }}
          onMouseEnter={() => {
            if (!draggingTaskId || draggingTaskId === task.id) {
              return;
            }
            void reorderSection(section, draggingTaskId, task.id);
          }}
          className={`group flex w-full animate-item-in items-center gap-3 rounded-[22px] border px-3 py-3 text-left transition ${
            draggingTaskId === task.id
              ? "border-[#8b94a5]/75 bg-white/[0.06]"
              : task.important && !task.completed
                ? "border-[#bb6a74]/82 bg-[linear-gradient(180deg,rgba(173,72,88,0.18),rgba(108,34,46,0.13))] shadow-[inset_0_1px_0_rgba(255,196,204,0.05)] hover:border-[#ca7883]/88 hover:bg-[linear-gradient(180deg,rgba(186,82,99,0.22),rgba(121,39,52,0.16))]"
                : task.completed
                  ? "border-[#59606d]/38 bg-[#8d96a3]/[0.08] hover:border-[#646d7b]/50 hover:bg-[#8d96a3]/[0.11]"
                  : "border-[#667080]/48 bg-white/[0.03] hover:border-[#7d8695]/55 hover:bg-white/[0.05]"
          } select-none`}
        >
          <button
            type="button"
            onClick={() => {
              if (!task.completed) {
                void markTaskAsCompleted(task.id);
              }
            }}
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] transition ${
              task.completed
                ? "border-[#f5be4f]/55 bg-[#f5be4f]/14 text-[#f5be4f]"
                : "border-[#6b7382]/45 bg-black/20 text-transparent hover:border-[#f5be4f]/55 hover:bg-[#f5be4f]/12 hover:text-[#f5be4f]"
            }`}
            aria-label={task.completed ? "Tarea completada" : "Completar tarea"}
          >
            ✓
          </button>
          <span
            className={`flex-1 text-sm leading-6 ${
              task.completed ? "text-[#a7afbc]/66 line-through decoration-[#9ea7b5]/55" : "text-white/88"
            }`}
          >
            {task.text}
          </span>
          {task.important && !task.completed ? (
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#df808d] shadow-[0_0_0_5px_rgba(223,128,141,0.18)]"
              aria-label="Tarea prioritaria"
              title="Tarea prioritaria"
            />
          ) : null}
        </div>
      ))}
    </div>
  );

  return (
    <main className="glass h-screen w-screen overflow-hidden rounded-[30px] bg-transparent text-slate-100">
      <section
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
            className="flex-1 cursor-default select-none"
          >
            <p className="text-[10px] uppercase tracking-[0.36em] text-white/30">
              Kyro capture
            </p>
            <h1 className="mt-2 text-[2rem] font-semibold tracking-[-0.04em] text-white">
              TODO
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
          />
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
              placeholder="Agrega una tarea"
              className="w-full rounded-[22px] border border-[#5f6674]/45 bg-white/[0.045] px-4 py-4 text-base text-white outline-none transition placeholder:text-white/26 focus:border-[#f5be4f]/42 focus:bg-white/[0.06] focus:ring-2 focus:ring-[#f5be4f]/10"
              autoComplete="off"
              autoCapitalize="sentences"
              autoCorrect="on"
            />
          </label>

          <div className="mb-3 flex items-center justify-between text-xs text-white/40">
            <span>{taskCountLabel}</span>
          </div>

          <div className="scroll-area min-h-0 flex-1 space-y-5 overflow-y-auto pr-2">
            <div className="space-y-2">
              {ready && pendingTasks.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-white/38">
                  Sin pendientes.
                </div>
              ) : null}
              {renderTaskList("pending", pendingTasks)}
            </div>

            {completedTasks.length > 0 ? (
              <div className="space-y-2 border-t border-white/6 pt-4">
                <button
                  type="button"
                  onClick={() => setCompletedCollapsed((value) => !value)}
                  className="flex items-center gap-2 rounded-xl bg-white/[0.07] px-3 py-2 text-sm text-white/82 transition hover:bg-white/[0.1]"
                >
                  <span className="text-[12px] text-white/70">
                    {completedCollapsed ? "›" : "⌄"}
                  </span>
                  <span>Completed</span>
                  <span className="text-white/48">{completedTasks.length}</span>
                </button>
                {!completedCollapsed ? renderTaskList("completed", completedTasks) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>
      {contextMenu && contextTask ? (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-2xl border border-[#667080]/55 bg-[rgba(18,22,30,0.94)] p-1.5 shadow-[0_20px_45px_rgba(0,0,0,0.45)] backdrop-blur-[24px]"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 196),
            top: Math.min(contextMenu.y, window.innerHeight - (contextTask.completed ? 68 : 108)),
          }}
        >
          <button
            type="button"
            onClick={() => void copyTaskText(contextTask.id)}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-white/84 transition hover:bg-white/[0.06]"
          >
            <span>Copiar</span>
            <span>⧉</span>
          </button>
          {!contextTask.completed ? (
            <button
              type="button"
              onClick={() => void toggleTaskImportant(contextTask.id)}
              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-white/84 transition hover:bg-white/[0.06]"
            >
              <span>
                {contextTask.important ? "Quitar importante" : "Marcar importante"}
              </span>
              <span className="text-[#f5be4f]/80">!</span>
              </button>
            ) : null}
          <div className="my-1 border-t border-white/8" />
          <button
            type="button"
            onClick={() => void deleteTask(contextTask.id)}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-[#ffb4b4] transition hover:bg-white/[0.06]"
          >
            <span>Eliminar tarea</span>
            <span>⌫</span>
          </button>
        </div>
      ) : null}
    </main>
  );
}
