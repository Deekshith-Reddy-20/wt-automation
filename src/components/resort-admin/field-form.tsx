"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { NotConfigured } from "./shared";

export type FieldType = "text" | "textarea" | "number" | "bool" | "time" | "date" | "select" | "list" | "numlist";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  options?: { value: string; label: string }[];
  /** Required by the database — never sent as null. */
  required?: boolean;
  step?: string;
  wide?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Values = Record<string, any>;

function toInput(def: FieldDef, v: any): any {
  if (def.type === "bool") return Boolean(v);
  if (def.type === "list" || def.type === "numlist") return Array.isArray(v) ? v.join(", ") : "";
  if (def.type === "time") return v ? String(v).slice(0, 5) : "";
  return v ?? "";
}

function fromInput(def: FieldDef, v: any): any {
  switch (def.type) {
    case "bool":
      return Boolean(v);
    case "number":
      return v === "" || v === null ? null : Number(v);
    case "list":
      return String(v).split(",").map((s) => s.trim()).filter(Boolean);
    case "numlist":
      return String(v).split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    default:
      return v === "" ? null : v;
  }
}

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/**
 * Small declarative form. Only changed fields are submitted, so a
 * partial PATCH never overwrites values the user didn't touch.
 */
export function FieldForm({
  fields,
  initial,
  disabled,
  onSubmit,
  submitLabel = "Save",
  showNotConfigured = false,
  columns = 2,
}: {
  fields: FieldDef[];
  initial: Values | null;
  disabled?: boolean;
  onSubmit: (changes: Values) => Promise<void>;
  submitLabel?: string;
  showNotConfigured?: boolean;
  columns?: 1 | 2 | 3;
}) {
  const make = () => Object.fromEntries(fields.map((f) => [f.key, toInput(f, initial?.[f.key])]));
  const [values, setValues] = useState<Values>(make);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues(make());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const changes = () => {
    const out: Values = {};
    for (const f of fields) {
      const next = fromInput(f, values[f.key]);
      const prev = initial?.[f.key] ?? (f.type === "bool" ? false : f.type === "list" || f.type === "numlist" ? [] : null);
      const prevNorm = f.type === "time" && prev ? String(prev).slice(0, 5) : f.type === "number" && prev !== null ? Number(prev) : prev;
      if (JSON.stringify(next) !== JSON.stringify(prevNorm)) {
        if (f.required && next === null) continue;
        out[f.key] = next;
      }
    }
    return out;
  };

  const set = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));
  const grid = columns === 1 ? "" : columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2";

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const c = changes();
        if (Object.keys(c).length === 0) return;
        setSaving(true);
        try {
          await onSubmit(c);
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-4"
    >
      <div className={`grid gap-4 ${grid}`}>
        {fields.map((f) => {
          const id = `f-${f.key}`;
          const empty = showNotConfigured && isEmptyValue(initial?.[f.key]) && f.type !== "bool";
          const span = f.wide || f.type === "textarea" ? "md:col-span-full" : "";
          if (f.type === "bool") {
            return (
              <div key={f.key} className={`flex items-start justify-between gap-3 rounded-lg border border-border p-3 ${span}`}>
                <div>
                  <Label htmlFor={id} className="text-sm">{f.label}</Label>
                  {f.hint && <p className="mt-0.5 text-xs text-muted-foreground">{f.hint}</p>}
                </div>
                <Switch id={id} checked={Boolean(values[f.key])} onCheckedChange={(v) => set(f.key, v)} disabled={disabled} />
              </div>
            );
          }
          return (
            <div key={f.key} className={span}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <Label htmlFor={id} className="text-xs">{f.label}</Label>
                {empty && <NotConfigured />}
              </div>
              {f.type === "textarea" ? (
                <Textarea id={id} rows={3} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} disabled={disabled} />
              ) : f.type === "select" ? (
                <select id={id} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} disabled={disabled}>
                  {!f.required && <option value="">—</option>}
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <Input
                  id={id}
                  type={f.type === "number" ? "number" : f.type === "time" ? "time" : f.type === "date" ? "date" : "text"}
                  step={f.step ?? (f.type === "number" ? "any" : undefined)}
                  value={values[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              )}
              {f.hint && <p className="mt-1 text-[11px] text-muted-foreground">{f.hint}</p>}
            </div>
          );
        })}
      </div>
      {!disabled && (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving}>{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{submitLabel}</Button>
        </div>
      )}
    </form>
  );
}
