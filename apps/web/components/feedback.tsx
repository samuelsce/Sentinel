"use client";
import { CircleAlert, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

export function Loading() {
  return (
    <div className="loading" role="status">
      Carregando dados…
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  return (
    <div className="feedback error" role="alert">
      <CircleAlert aria-hidden="true" />
      <div>
        <strong>Não foi possível concluir</strong>
        <p>{error.message}</p>
        <Button variant="outline" onClick={retry}>
          <RefreshCw aria-hidden="true" />
          Tentar novamente
        </Button>
      </div>
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <FolderOpen aria-hidden="true" />
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}
export function Confirm({
  label,
  prompt,
  confirmLabel = "Confirmar",
  action,
}: {
  label: string;
  prompt: string;
  confirmLabel?: string;
  action: () => Promise<void>;
}) {
  const [state, setState] = useState<"idle" | "confirm" | "pending" | "done">(
      "idle",
    ),
    [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null),
    start = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state === "confirm") cancel.current?.focus();
  }, [state]);
  const reset = () => {
    setState("idle");
    setError("");
    requestAnimationFrame(() => start.current?.focus());
  };
  return (
    <div className="confirm-action">
      {state === "idle" || state === "done" ? (
        <Button
          ref={start}
          variant="outline"
          onClick={() => {
            setState("confirm");
            setError("");
          }}
        >
          {state === "done" ? "Concluído" : label}
        </Button>
      ) : (
        <fieldset disabled={state === "pending"} className="confirmation">
          <legend>{prompt}</legend>
          <Button
            ref={cancel}
            variant="ghost"
            onClick={reset}
            onKeyDown={(e) => {
              if (e.key === "Escape") reset();
            }}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onKeyDown={(e) => {
              if (e.key === "Escape") reset();
            }}
            onClick={async () => {
              setState("pending");
              try {
                await action();
                setState("done");
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Tente novamente.",
                );
                setState("confirm");
              }
            }}
          >
            {state === "pending" ? "Salvando…" : confirmLabel}
          </Button>
        </fieldset>
      )}
      <p className="sr-only" role="status">
        {state === "pending"
          ? "Processando ação"
          : state === "done"
            ? "Ação concluída"
            : ""}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
