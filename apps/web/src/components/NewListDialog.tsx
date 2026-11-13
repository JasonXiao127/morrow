import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { apiErrorMessage } from "@/api";
import { useCreateList } from "@/lib/queries";
import { uuidv7 } from "@/lib/utils";
import { DialogFrame } from "./DialogFrame";

const COLORS = [
  { id: "persimmon", label: "Persimmon" },
  { id: "moss", label: "Moss" },
  { id: "ochre", label: "Ochre" },
  { id: "slate", label: "Slate" },
  { id: "plum", label: "Plum" },
  { id: "rose", label: "Rose" },
] as const;

export function NewListDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("persimmon");
  const [error, setError] = useState<string | null>(null);
  const createList = useCreateList();

  useEffect(() => {
    if (open) {
      setName("");
      setColor("persimmon");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the list a name.");
      return;
    }
    setError(null);
    try {
      await createList.mutateAsync({ id: uuidv7(), name: trimmed, color });
      onOpenChange(false);
    } catch (submitError) {
      setError(apiErrorMessage(submitError));
    }
  };

  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title="New list"
      description="Group reminders by context or project."
    >
      <form
        className="p-5 md:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="serif text-22">New list</h2>
            <p className="mt-1 text-13 text-muted">
              A quiet home for related things.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn -mr-2 -mt-2"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-5">
          <label htmlFor="list-name" className="field-label">
            Name
          </label>
          <input
            id="list-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Errands, Studio, Garden…"
            autoFocus
            maxLength={120}
          />
        </div>

        <fieldset className="mt-5">
          <legend className="field-label">Colour</legend>
          <div className="flex flex-wrap gap-1.5">
            {COLORS.map((option) => (
              <button
                key={option.id}
                type="button"
                data-list-color={option.id}
                aria-label={option.label}
                aria-pressed={color === option.id}
                className="flex h-11 w-11 items-center justify-center rounded-md border border-transparent hover:bg-selection aria-pressed:border-hairline-strong aria-pressed:bg-selection"
                onClick={() => setColor(option.id)}
              >
                <span className="list-dot h-4 w-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        </fieldset>

        {error ? (
          <p role="alert" className="mt-4 text-13 text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createList.isPending}
            aria-busy={createList.isPending}
          >
            {createList.isPending ? "Adding…" : "Add list"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
