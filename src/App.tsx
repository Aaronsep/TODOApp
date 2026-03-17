import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const TASK_METADATA_SCHEMA_VERSION = 1;

type TaskMetadata = {
  schemaVersion: number;
  updatedAt: string;
  lastCompletedAt: string | null;
  lastReopenedAt: string | null;
  lastImportanceChangeAt: string | null;
  lastReorderedAt: string | null;
};

type Task = {
  id: string;
  text: string;
  description: string;
  createdAt: string;
  completed: boolean;
  important: boolean;
  metadata: TaskMetadata;
};

const appWindow = getCurrentWindow();

type TaskSection = "pending" | "completed";
type ContextMenuState = {
  type: "task" | "completed-section";
  taskId?: string;
  x: number;
  y: number;
} | null;
type DeleteConfirmState = {
  taskId: string;
  text: string;
  mode: "single" | "completed-bulk";
} | null;

function createTaskMetadata(timestamp: string): TaskMetadata {
  return {
    schemaVersion: TASK_METADATA_SCHEMA_VERSION,
    updatedAt: timestamp,
    lastCompletedAt: null,
    lastReopenedAt: null,
    lastImportanceChangeAt: null,
    lastReorderedAt: null,
  };
}

function patchTaskMetadata(
  task: Task,
  patch: Partial<TaskMetadata>,
  timestamp = new Date().toISOString(),
): Task {
  return {
    ...task,
    metadata: {
      ...task.metadata,
      schemaVersion: TASK_METADATA_SCHEMA_VERSION,
      updatedAt: timestamp,
      ...patch,
    },
  };
}

function applyCompletedState(task: Task, timestamp = new Date().toISOString()): Task {
  return {
    ...patchTaskMetadata(
      task,
      {
        lastCompletedAt: timestamp,
        lastImportanceChangeAt: task.important
          ? timestamp
          : task.metadata.lastImportanceChangeAt,
      },
      timestamp,
    ),
    completed: true,
    important: false,
  };
}

function applyPendingState(task: Task, timestamp = new Date().toISOString()): Task {
  return {
    ...patchTaskMetadata(task, { lastReopenedAt: timestamp }, timestamp),
    completed: false,
  };
}

function applyImportantState(
  task: Task,
  important: boolean,
  timestamp = new Date().toISOString(),
): Task {
  return {
    ...patchTaskMetadata(task, { lastImportanceChangeAt: timestamp }, timestamp),
    important,
  };
}

function applyReorderedMetadata(tasks: Task[], timestamp = new Date().toISOString()): Task[] {
  return tasks.map((task) =>
    patchTaskMetadata(task, { lastReorderedAt: timestamp }, timestamp),
  );
}

function applyDescriptionState(
  task: Task,
  description: string,
  timestamp = new Date().toISOString(),
): Task {
  return {
    ...patchTaskMetadata(task, {}, timestamp),
    description,
  };
}

function createTask(text: string): Task {
  const createdAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    text,
    description: "",
    createdAt,
    completed: false,
    important: false,
    metadata: createTaskMetadata(createdAt),
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
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusTitleRef = useRef<HTMLButtonElement>(null);
  const resizeUnlockTimerRef = useRef<number | null>(null);
  const descriptionSaveTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ready, setReady] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [completedCollapsed, setCompletedCollapsed] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [focusedDescription, setFocusedDescription] = useState("");
  const [focusTitleExpanded, setFocusTitleExpanded] = useState(false);
  const [clipboardToastVisible, setClipboardToastVisible] = useState(false);

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
        if (deleteConfirm) {
          setDeleteConfirm(null);
          return;
        }
        if (focusedTaskId) {
          event.preventDefault();
          await closeFocusMode();
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
  }, [contextMenu, deleteConfirm, focusedTaskId]);

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
    if (!focusTitleExpanded) {
      return;
    }

    const collapseTitle = (event: MouseEvent) => {
      if (focusTitleRef.current?.contains(event.target as Node)) {
        return;
      }

      setFocusTitleExpanded(false);
    };

    window.addEventListener("mousedown", collapseTitle);

    return () => {
      window.removeEventListener("mousedown", collapseTitle);
    };
  }, [focusTitleExpanded]);

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

  useEffect(() => {
    if (!focusedTaskId) {
      if (descriptionSaveTimerRef.current !== null) {
        window.clearTimeout(descriptionSaveTimerRef.current);
        descriptionSaveTimerRef.current = null;
      }
      return;
    }

    const focusedTask = tasks.find((task) => task.id === focusedTaskId);
    if (!focusedTask) {
      setFocusedTaskId(null);
      setFocusedDescription("");
      return;
    }

    if (focusedDescription === focusedTask.description) {
      return;
    }

    if (descriptionSaveTimerRef.current !== null) {
      window.clearTimeout(descriptionSaveTimerRef.current);
    }

    descriptionSaveTimerRef.current = window.setTimeout(() => {
      descriptionSaveTimerRef.current = null;
      const nextTasks = tasks.map((task) =>
        task.id === focusedTaskId ? applyDescriptionState(task, focusedDescription) : task,
      );
      void persistTasks(nextTasks);
    }, 180);

    return () => {
      if (descriptionSaveTimerRef.current !== null) {
        window.clearTimeout(descriptionSaveTimerRef.current);
      }
    };
  }, [focusedDescription, focusedTaskId, tasks]);

  useEffect(() => {
    document.title = focusedTaskId
      ? tasks.find((task) => task.id === focusedTaskId)?.text ?? "TODO"
      : "TODO";
  }, [focusedTaskId, tasks]);

  useEffect(() => {
    const bindResizeEvents = async () => {
      const unlistenResized = await appWindow.onResized(() => {
        if (resizeUnlockTimerRef.current !== null) {
          window.clearTimeout(resizeUnlockTimerRef.current);
        }

        resizeUnlockTimerRef.current = window.setTimeout(() => {
          resizeUnlockTimerRef.current = null;
          void appWindow.setResizable(false);
        }, 140);
      });

      return () => {
        if (resizeUnlockTimerRef.current !== null) {
          window.clearTimeout(resizeUnlockTimerRef.current);
        }
        unlistenResized();
      };
    };

    const cleanupPromise = bindResizeEvents();

    return () => {
      void cleanupPromise.then((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
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
    setDeleteConfirm(null);
    if (focusedTaskId === taskId) {
      setFocusedTaskId(null);
      setFocusedDescription("");
    }
    await persistTasks(nextTasks);
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  const requestDeleteTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    setContextMenu(null);
    setDeleteConfirm({
      taskId,
      text: task.text,
      mode: "single",
    });
  };

  const requestDeleteCompletedTasks = () => {
    if (completedTasks.length === 0) {
      return;
    }
    setContextMenu(null);
    setDeleteConfirm({
      taskId: "__completed_bulk__",
      text: `${completedTasks.length} tareas completadas`,
      mode: "completed-bulk",
    });
  };

  const deleteCompletedTasks = async () => {
    const nextTasks = tasks.filter((task) => !task.completed);
    setDeleteConfirm(null);
    if (focusedTaskId && completedTasks.some((task) => task.id === focusedTaskId)) {
      setFocusedTaskId(null);
      setFocusedDescription("");
    }
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
      applyCompletedState(pendingTask),
    ];

    setContextMenu(null);
    await persistTasks(rebuildTasks(nextPendingTasks, nextCompletedTasks));
    window.setTimeout(() => inputRef.current?.focus(), 10);
  };

  const markTaskAsPending = async (taskId: string) => {
    const completedTask = completedTasks.find((task) => task.id === taskId);
    if (!completedTask) {
      return;
    }

    const importantTasks = pendingTasks.filter((task) => task.important);
    const regularTasks = pendingTasks.filter((task) => !task.important);
    const nextPendingTasks = [
      ...importantTasks,
      applyPendingState(completedTask),
      ...regularTasks,
    ];
    const nextCompletedTasks = completedTasks.filter((task) => task.id !== taskId);

    setContextMenu(null);
    await persistTasks(rebuildTasks(nextPendingTasks, nextCompletedTasks));
  };

  const toggleTaskImportant = async (taskId: string) => {
    const task = pendingTasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    let nextPendingTasks: Task[];

    if (task.important) {
      nextPendingTasks = pendingTasks.map((item) =>
        item.id === taskId ? applyImportantState(item, false) : item,
      );
    } else {
      const remainingTasks = pendingTasks.filter((item) => item.id !== taskId);
      const importantTasks = remainingTasks.filter((item) => item.important);
      const regularTasks = remainingTasks.filter((item) => !item.important);
      nextPendingTasks = [
        applyImportantState(task, true),
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
      await copyTextToClipboard(task.text);
    } catch (error) {
      console.error("Failed to copy task text", error);
    } finally {
      setContextMenu(null);
    }
  };

  const showClipboardToast = () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    setClipboardToastVisible(true);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setClipboardToastVisible(false);
    }, 1200);
  };

  const copyTextToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showClipboardToast();
    } catch (error) {
      console.error("Failed to copy text", error);
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

    const reorderedSectionTasks = applyReorderedMetadata(moveItem(sectionTasks, fromIndex, toIndex));
    const nextTasks =
      section === "pending"
        ? rebuildTasks(reorderedSectionTasks, completedTasks)
        : rebuildTasks(pendingTasks, reorderedSectionTasks);

    await persistTasks(nextTasks);
  };

  const taskCountLabel =
    pendingTasks.length === 1 ? "1 pendiente" : `${pendingTasks.length} pendientes`;

  const focusedTask = focusedTaskId
    ? tasks.find((task) => task.id === focusedTaskId) ?? null
    : null;

  const contextTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;

  const openFocusMode = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    setContextMenu(null);
    setDeleteConfirm(null);
    setDraggingTaskId(null);
    setFocusedTaskId(taskId);
    setFocusedDescription(task.description);
    setFocusTitleExpanded(false);
    window.setTimeout(() => {
      const textarea = descriptionRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }, 30);
  };

  const flushFocusedDescription = async (taskId: string | null, description: string) => {
    if (!taskId) {
      return;
    }

    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.description === description) {
      return;
    }

    if (descriptionSaveTimerRef.current !== null) {
      window.clearTimeout(descriptionSaveTimerRef.current);
      descriptionSaveTimerRef.current = null;
    }

    await persistTasks(
      tasks.map((item) =>
        item.id === taskId ? applyDescriptionState(item, description) : item,
      ),
    );
  };

  const closeFocusMode = async () => {
    await flushFocusedDescription(focusedTaskId, focusedDescription);
    setFocusedTaskId(null);
    setFocusedDescription("");
    setFocusTitleExpanded(false);
    window.setTimeout(() => inputRef.current?.focus(), 20);
  };

  const startCornerResize = async (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (resizeUnlockTimerRef.current !== null) {
      window.clearTimeout(resizeUnlockTimerRef.current);
      resizeUnlockTimerRef.current = null;
    }

    await invoke("start_window_resize_corner");
  };

  const getContextMenuPosition = (menuType: "task" | "completed-section") => {
    const estimatedHeight =
      menuType === "completed-section"
        ? 104
        : contextTask?.completed
          ? 118
          : 156;
    const estimatedWidth = menuType === "completed-section" ? 236 : 196;

    return {
      left: Math.max(12, Math.min((contextMenu?.x ?? 12), window.innerWidth - estimatedWidth - 12)),
      top: Math.max(12, Math.min((contextMenu?.y ?? 12), window.innerHeight - estimatedHeight - 12)),
    };
  };

  const markAllCompletedAsPending = async () => {
    if (completedTasks.length === 0) {
      return;
    }

    const importantTasks = pendingTasks.filter((task) => task.important);
    const regularTasks = pendingTasks.filter((task) => !task.important);
    const restoredTasks = completedTasks.map((task) => ({
      ...applyPendingState(task),
    }));

    setContextMenu(null);
    await persistTasks([...importantTasks, ...restoredTasks, ...regularTasks]);
  };

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
              type: "task",
              taskId: task.id,
              x: event.clientX,
              y: event.clientY,
            });
          }}
          onDoubleClick={() => {
            openFocusMode(task.id);
          }}
          onMouseEnter={() => {
            if (!draggingTaskId || draggingTaskId === task.id) {
              return;
            }
            void reorderSection(section, draggingTaskId, task.id);
          }}
          className={`group flex w-full animate-item-in items-center gap-3 rounded-[22px] border px-3 py-3 text-left transition ${
            draggingTaskId === task.id
              ? "border-white/70 bg-white/[0.06]"
              : task.important && !task.completed
                ? "border-[rgba(123,88,96,0.48)] bg-[linear-gradient(180deg,rgba(173,72,88,0.18),rgba(108,34,46,0.13))] shadow-[inset_0_1px_0_rgba(255,196,204,0.05)] hover:border-[rgba(226,230,238,0.78)] hover:bg-[linear-gradient(180deg,rgba(186,82,99,0.22),rgba(121,39,52,0.16))]"
                : task.completed
                  ? "border-[rgba(100,109,122,0.42)] bg-[linear-gradient(180deg,rgba(112,120,132,0.12),rgba(83,90,101,0.09))] hover:border-[rgba(226,230,238,0.62)] hover:bg-[linear-gradient(180deg,rgba(122,130,143,0.14),rgba(88,96,108,0.11))]"
                  : "border-[rgba(104,113,126,0.44)] bg-white/[0.03] hover:border-[rgba(230,234,241,0.72)] hover:bg-white/[0.05]"
          } select-none`}
        >
          <button
            type="button"
            onClick={() => {
              if (task.completed) {
                void markTaskAsPending(task.id);
              } else {
                void markTaskAsCompleted(task.id);
              }
            }}
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] transition ${
              task.completed
                ? "border-transparent bg-[#8f98a6] text-[12px] font-black text-[#20262e]"
                : "border-[#6b7382]/45 bg-black/20 text-transparent hover:border-[#f5be4f]/55 hover:bg-[#f5be4f]/12 hover:text-[#f5be4f]"
            }`}
            aria-label={task.completed ? "Regresar tarea a pendientes" : "Completar tarea"}
          >
            ✓
          </button>
          <span
            className={`flex-1 text-sm leading-6 ${
              task.completed ? "text-[#8d96a3] line-through decoration-[#8d96a3]" : "text-white/88"
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
      <div
        className="absolute bottom-0 right-0 z-20 h-5 w-5 cursor-se-resize"
        onMouseDown={(event) => {
          void startCornerResize(event);
        }}
      />
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
            {!focusedTask ? (
              <h1 className="mt-2 text-[2rem] font-semibold tracking-[-0.04em] text-white">
                TODO
              </h1>
            ) : null}
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

        {focusedTask ? (
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => {
                  void closeFocusMode();
                }}
                className="flex h-9 w-9 items-center justify-center text-white/72 transition hover:text-white"
                aria-label="Volver"
                title="Volver"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <button
                ref={focusTitleRef}
                type="button"
                onClick={() => setFocusTitleExpanded((value) => !value)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void copyTextToClipboard(focusedTask.text);
                }}
                className={`max-w-[320px] pt-0.5 text-left text-[2.05rem] font-semibold leading-tight tracking-[-0.05em] text-white ${
                  focusTitleExpanded ? "" : "truncate"
                }`}
                title={focusTitleExpanded ? undefined : focusedTask.text}
              >
                {focusedTask.text}
              </button>
            </div>

            <div className="mt-5 flex items-center justify-between gap-4 text-sm text-white/54">
              <div className="flex items-center gap-4">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-2 ${
                    focusedTask.completed
                      ? "bg-white/[0.08] text-white/48"
                      : focusedTask.important
                        ? "bg-[rgba(164,74,88,0.22)] text-[#f0b5be]"
                        : "bg-[rgba(58,77,128,0.36)] text-white/76"
                  }`}
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      focusedTask.completed
                        ? "bg-[#79c88b]"
                        : focusedTask.important
                          ? "bg-[#e08d98]"
                          : "bg-[#f2bf5d]"
                    }`}
                  />
                  {focusedTask.completed
                    ? "Completada"
                    : focusedTask.important
                      ? "Prioritaria"
                      : "Pendiente"}
                </span>
                <span className="text-white/56">
                  {new Date(focusedTask.createdAt).toLocaleDateString("es-MX", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {!focusedTask.completed ? (
                  <button
                    type="button"
                    onClick={() => {
                      void toggleTaskImportant(focusedTask.id);
                    }}
                    className={`flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-white/[0.05] ${
                      focusedTask.important
                        ? "text-[#e08d98]"
                        : "text-white/58 hover:text-white"
                    }`}
                    aria-label={focusedTask.important ? "Quitar prioridad" : "Marcar prioritaria"}
                    title={focusedTask.important ? "Quitar prioridad" : "Marcar prioritaria"}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 5v9" />
                      <path d="M12 18.5v.5" />
                    </svg>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (focusedTask.completed) {
                      void markTaskAsPending(focusedTask.id);
                    } else {
                      void markTaskAsCompleted(focusedTask.id);
                    }
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-white/58 transition hover:bg-white/[0.05] hover:text-white"
                  aria-label={focusedTask.completed ? "Marcar incompleta" : "Marcar completada"}
                  title={focusedTask.completed ? "Marcar incompleta" : "Marcar completada"}
                >
                  {focusedTask.completed ? (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                  ) : (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 12.5l3.2 3.2L16 9" />
                      <path d="M11 12.5l3.2 3.2L21 9" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <div className="mt-5 h-px shrink-0 bg-white/[0.07]" />

            <div className="mt-5 flex min-h-0 flex-1 flex-col">
              <div className="mb-4 text-[11px] uppercase tracking-[0.34em] text-white/34">
                Descripción
              </div>
              <label className="flex min-h-0 flex-1 flex-col">
                <textarea
                  ref={descriptionRef}
                  value={focusedDescription}
                  onChange={(event) => setFocusedDescription(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }

                    if (event.shiftKey) {
                      return;
                    }

                    event.preventDefault();
                    void closeFocusMode();
                  }}
                  placeholder="Agrega una descripción"
                  className="min-h-0 flex-1 resize-none appearance-none rounded-[26px] border border-[#5f6674]/16 bg-[rgba(18,24,36,0.58)] px-5 py-5 text-sm leading-7 text-white/82 outline-none transition placeholder:text-white/24 hover:border-white/62 focus:border-[#f5be4f]/34 focus:bg-[rgba(22,28,40,0.62)] [color-scheme:dark] caret-white"
                  style={{ WebkitTextFillColor: "rgba(255,255,255,0.82)" }}
                />
              </label>
            </div>

            <div className="mt-5 h-px shrink-0 bg-white/[0.07]" />

            <div className="flex items-center justify-between pt-5">
              <button
                type="button"
                onClick={() => requestDeleteTask(focusedTask.id)}
                className="flex items-center gap-3 text-[1.05rem] text-[#d99ba5] transition hover:text-[#e7aab4]"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4.8c0-.7.56-1.3 1.25-1.3h5.5c.69 0 1.25.6 1.25 1.3V6" />
                  <path d="M6.5 6l.9 12.1c.05.8.72 1.4 1.52 1.4h6.16c.8 0 1.47-.6 1.52-1.4L17.5 6" />
                  <path d="M10 10.5v5.5" />
                  <path d="M14 10.5v5.5" />
                </svg>
                <span>Eliminar tarea</span>
              </button>
            </div>
          </div>
        ) : (
          <>
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
                  className="w-full rounded-[22px] border border-[#5f6674]/16 bg-white/[0.045] px-4 py-4 text-base text-white outline-none transition placeholder:text-white/26 hover:border-white/68 focus:border-[#f5be4f]/42 focus:bg-white/[0.06] focus:ring-2 focus:ring-[#f5be4f]/10"
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
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                          type: "completed-section",
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
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
          </>
        )}
      </section>
      {contextMenu && contextMenu.type === "task" && contextTask ? (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-2xl border border-[#667080]/55 bg-[rgba(18,22,30,0.94)] p-1.5 shadow-[0_20px_45px_rgba(0,0,0,0.45)] backdrop-blur-[24px]"
          style={getContextMenuPosition("task")}
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
          <button
            type="button"
            onClick={() =>
              void (contextTask.completed
                ? markTaskAsPending(contextTask.id)
                : markTaskAsCompleted(contextTask.id))
            }
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-white/84 transition hover:bg-white/[0.06]"
          >
            <span>
              {contextTask.completed ? "Marcar incompleta" : "Marcar completada"}
            </span>
            <span>{contextTask.completed ? "↺" : "✓"}</span>
          </button>
          <div className="my-1 border-t border-white/8" />
          <button
            type="button"
            onClick={() => requestDeleteTask(contextTask.id)}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-[#ffb4b4] transition hover:bg-white/[0.06]"
          >
            <span>Eliminar tarea</span>
            <span>⌫</span>
          </button>
        </div>
      ) : null}
      {contextMenu && contextMenu.type === "completed-section" ? (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-2xl border border-[#667080]/55 bg-[rgba(18,22,30,0.94)] p-1.5 shadow-[0_20px_45px_rgba(0,0,0,0.45)] backdrop-blur-[24px]"
          style={getContextMenuPosition("completed-section")}
        >
          <button
            type="button"
            onClick={() => void markAllCompletedAsPending()}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-white/84 transition hover:bg-white/[0.06]"
          >
            <span>Marcar todas incompletas</span>
            <span>↺</span>
          </button>
          <div className="my-1 border-t border-white/8" />
          <button
            type="button"
            onClick={() => requestDeleteCompletedTasks()}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-[#ffb4b4] transition hover:bg-white/[0.06]"
          >
            <span>Eliminar completadas</span>
            <span>⌫</span>
          </button>
        </div>
      ) : null}
      {deleteConfirm ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/28 px-4 backdrop-blur-[6px]">
          <div className="w-full max-w-[320px] rounded-[24px] border border-[#667080]/45 bg-[rgba(18,22,30,0.96)] p-4 shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
            <p className="text-sm font-medium text-white">Eliminar tarea</p>
            <p className="mt-2 text-sm leading-6 text-white/62">
              {deleteConfirm.mode === "completed-bulk"
                ? "Esta accion borrara permanentemente todas las tareas completadas."
                : "Esta accion borrara la tarea permanentemente."}
            </p>
            <p className="mt-3 truncate rounded-xl bg-white/[0.04] px-3 py-2 text-sm text-white/78">
              {deleteConfirm.text}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/72 transition hover:bg-white/[0.08]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() =>
                  void (deleteConfirm.mode === "completed-bulk"
                    ? deleteCompletedTasks()
                    : deleteTask(deleteConfirm.taskId))
                }
                className="rounded-xl bg-[#a65463] px-3 py-2 text-sm text-white transition hover:bg-[#bb6171]"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {clipboardToastVisible ? (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-[rgba(18,22,30,0.92)] px-3 py-1.5 text-xs text-white/82 shadow-[0_16px_40px_rgba(0,0,0,0.32)] backdrop-blur-[18px]">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
          </svg>
          <span>Copiado al portapapeles</span>
        </div>
      ) : null}
    </main>
  );
}
