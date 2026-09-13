import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useRules, newRule, type AutomationRule, type RuleAction } from "../../store/ruleStore";
import { useTags } from "../../store/tagStore";
import { useColorLabels } from "../../store/colorLabelStore";
import { useFollowPathChange } from "../../hooks/useFollowPathChange";
import { executeRule, type ExecutionLogEntry } from "../../lib/ruleExecutor";
import { COLOR_LABEL_COLORS } from "../../hooks/useFileFilter";
import { showToast } from "../../lib/toast";
import Icon from "../common/Icon";

type RowState = {
  expanded: boolean;
  testResult: { matched: number; log: ExecutionLogEntry[] } | null;
  running: boolean;
};

/** 設定で使われている既存のカラーラベル変更ヘルパと同じキーを共有。 */
type Props = {
  /** パネル右上の × から閉じる（ActivityBar のトグルと同じ導線） */
  onClose?: () => void;
};

export default function RuleManagerPanel({ onClose }: Props = {}) {
  const { t } = useTranslation();
  const { rules, loaded, addRule, updateRule, removeRule, reorderRule } = useRules();
  const { addTag } = useTags();
  // ルールで付けたラベルは以前 localStorage の旧キーへ書いており保存されなかった。
  // ストア経由に統一し、ファイル移動にはタグ・ラベルを追従させる。
  const { setColorLabel } = useColorLabels();
  const followPathChange = useFollowPathChange();
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  const setRow = useCallback((id: string, patch: Partial<RowState>) => {
    setRowState((prev) => ({
      ...prev,
      [id]: { ...{ expanded: false, testResult: null, running: false }, ...prev[id], ...patch },
    }));
  }, []);

  const handleAddRule = useCallback(() => {
    const r = newRule();
    addRule(r);
    setRow(r.id, { expanded: true });
  }, [addRule, setRow]);

  const handlePickWatchPath = useCallback(
    async (rule: AutomationRule) => {
      try {
        const selected = await openDialog({ directory: true, multiple: false, defaultPath: rule.watchPath || undefined });
        if (typeof selected === "string") {
          updateRule(rule.id, { watchPath: selected });
        }
      } catch {
        /* ignore */
      }
    },
    [updateRule],
  );

  const handleTest = useCallback(
    async (rule: AutomationRule) => {
      setRow(rule.id, { running: true, testResult: null });
      try {
        const res = await executeRule(rule, { addTag, setColorLabel }, { dryRun: true });
        setRow(rule.id, { running: false, testResult: { matched: res.matched.length, log: res.log } });
      } catch (e) {
        showToast(t("rules.testFailed", { error: e }));
        setRow(rule.id, { running: false });
      }
    },
    [addTag, setColorLabel, setRow, t],
  );

  const handleRun = useCallback(
    async (rule: AutomationRule) => {
      if (rule.actions.length === 0) {
        showToast(t("rules.noAction"));
        return;
      }
      if (!window.confirm(t("rules.confirmRun", { name: rule.name }))) return;
      setRow(rule.id, { running: true });
      try {
        const res = await executeRule(rule, { addTag, setColorLabel, followPathChange });
        const okCount = res.log.filter((l) => l.ok).length;
        const errCount = res.log.length - okCount;
        showToast(t("rules.runDone", { ok: okCount, err: errCount }));
        setRow(rule.id, { running: false, testResult: { matched: res.matched.length, log: res.log } });
      } catch (e) {
        showToast(t("rules.runFailed", { error: e }));
        setRow(rule.id, { running: false });
      }
    },
    [addTag, setColorLabel, followPathChange, setRow, t],
  );

  return (
    <div
      className="w-80 flex-shrink-0 flex flex-col border-l text-xs overflow-hidden"
      style={{ backgroundColor: "var(--kf-bg-primary)", borderColor: "var(--kf-border)", color: "var(--kf-text-primary)" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ backgroundColor: "var(--kf-bg-secondary)", borderColor: "var(--kf-border)" }}
      >
        <Icon name="bolt" size={14} style={{ color: "var(--kf-text-muted)" }} />
        <span className="font-semibold flex-1">{t("rules.title")}</span>
        <button
          onClick={handleAddRule}
          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:opacity-80"
          style={{ color: "var(--kf-accent)" }}
          title={t("rules.newRule")}
        >
          <Icon name="add" size={14} />
          {t("rules.new")}
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center opacity-50 hover:opacity-100 transition-opacity"
            title={t("common.close")}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {/* Empty state */}
      {loaded && rules.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 gap-2 px-4 text-center" style={{ color: "var(--kf-text-muted)" }}>
          <Icon name="bolt" size={24} />
          <span>{t("rules.noRules")}</span>
          <span className="text-[10px]">{t("rules.noRulesHint")}</span>
        </div>
      )}

      {/* Rule list */}
      <div className="flex-1 overflow-y-auto">
        {rules.map((rule, idx) => {
          const state = rowState[rule.id] ?? { expanded: false, testResult: null, running: false };
          return (
            <RuleCard
              key={rule.id}
              rule={rule}
              state={state}
              isFirst={idx === 0}
              isLast={idx === rules.length - 1}
              onChange={(patch) => updateRule(rule.id, patch)}
              onToggleExpand={() => setRow(rule.id, { expanded: !state.expanded })}
              onRemove={() => {
                if (window.confirm(t("rules.confirmDelete", { name: rule.name }))) removeRule(rule.id);
              }}
              onMoveUp={() => reorderRule(rule.id, "up")}
              onMoveDown={() => reorderRule(rule.id, "down")}
              onPickPath={() => handlePickWatchPath(rule)}
              onTest={() => handleTest(rule)}
              onRun={() => handleRun(rule)}
            />
          );
        })}
      </div>

      {/* Footer hint */}
      <div
        className="px-3 py-1.5 border-t text-[10px] shrink-0"
        style={{ borderColor: "var(--kf-border-soft)", color: "var(--kf-text-muted)" }}
      >
        <Icon name="info" size={10} className="inline align-text-bottom mr-1" />
        {t("rules.autoRunNote")}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
function RuleCard({
  rule, state, isFirst, isLast,
  onChange, onToggleExpand, onRemove, onMoveUp, onMoveDown, onPickPath, onTest, onRun,
}: {
  rule: AutomationRule;
  state: RowState;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<AutomationRule>) => void;
  onToggleExpand: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onPickPath: () => void;
  onTest: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-b" style={{ borderColor: "var(--kf-border-soft)" }}>
      {/* Header row */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={onToggleExpand} className="flex items-center" title={state.expanded ? t("rules.collapse") : t("rules.expand")}>
          <Icon name={state.expanded ? "expand_more" : "chevron_right"} size={14} />
        </button>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          title={t("rules.enableRule")}
        />
        <input
          value={rule.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="flex-1 bg-transparent outline-none px-1 py-0.5 rounded"
          style={{ border: "1px solid transparent", color: "var(--kf-text-primary)" }}
          onFocus={(e) => (e.currentTarget.style.borderColor = "var(--kf-border)")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "transparent")}
        />
        <button onClick={onMoveUp} disabled={isFirst} className="flex items-center disabled:opacity-30" title={t("rules.moveUp")}>
          <Icon name="arrow_upward" size={12} />
        </button>
        <button onClick={onMoveDown} disabled={isLast} className="flex items-center disabled:opacity-30" title={t("rules.moveDown")}>
          <Icon name="arrow_downward" size={12} />
        </button>
        <button onClick={onRemove} className="flex items-center opacity-60 hover:opacity-100" title={t("rules.delete")}>
          <Icon name="delete" size={12} />
        </button>
      </div>

      {/* Body */}
      {state.expanded && (
        <div className="px-3 pb-2 flex flex-col gap-2">
          {/* Watch path */}
          <Field label={t("rules.watchDir")}>
            <div className="flex items-center gap-1">
              <input
                value={rule.watchPath}
                onChange={(e) => onChange({ watchPath: e.target.value })}
                placeholder={t("rules.watchDirPlaceholder")}
                className="flex-1 bg-transparent outline-none rounded px-1.5 py-0.5"
                style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
              />
              <button
                onClick={onPickPath}
                className="flex items-center px-1.5 py-0.5 rounded"
                style={{ color: "var(--kf-accent)" }}
                title={t("rules.pickFolder")}
              >
                <Icon name="folder_open" size={13} />
              </button>
            </div>
          </Field>

          {/* Conditions */}
          <Field label={t("rules.extensions")}>
            <input
              value={(rule.conditions.extensions ?? []).join(", ")}
              onChange={(e) =>
                onChange({
                  conditions: {
                    ...rule.conditions,
                    extensions: e.target.value
                      .split(",")
                      .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
                      .filter(Boolean),
                  },
                })
              }
              placeholder={t("rules.extensionsPlaceholder")}
              className="bg-transparent outline-none rounded px-1.5 py-0.5"
              style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
            />
          </Field>

          <Field label={t("rules.namePattern")}>
            <input
              value={rule.conditions.namePattern ?? ""}
              onChange={(e) =>
                onChange({
                  conditions: { ...rule.conditions, namePattern: e.target.value || null },
                })
              }
              placeholder={t("rules.namePatternPlaceholder")}
              className="bg-transparent outline-none rounded px-1.5 py-0.5"
              style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
            />
          </Field>

          <Field label={t("rules.minSize")}>
            <input
              type="number"
              min={0}
              value={rule.conditions.minSize ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onChange({
                  conditions: { ...rule.conditions, minSize: v === "" ? null : Number(v) },
                });
              }}
              className="bg-transparent outline-none rounded px-1.5 py-0.5"
              style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
            />
          </Field>

          {/* Actions */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span style={{ color: "var(--kf-text-muted)" }}>{t("rules.action")}</span>
              <ActionAddMenu
                onAdd={(a) => onChange({ actions: [...rule.actions, a] })}
              />
            </div>
            {rule.actions.length === 0 ? (
              <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>{t("rules.notSet")}</span>
            ) : (
              rule.actions.map((a, i) => (
                <ActionRow
                  key={i}
                  action={a}
                  onChange={(next) => {
                    const arr = [...rule.actions];
                    arr[i] = next;
                    onChange({ actions: arr });
                  }}
                  onRemove={() => onChange({ actions: rule.actions.filter((_, idx) => idx !== i) })}
                />
              ))
            )}
          </div>

          {/* AutoRun + buttons */}
          <div className="flex items-center justify-between gap-2 mt-1 pt-2 border-t" style={{ borderColor: "var(--kf-border-soft)" }}>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={rule.autoRun}
                onChange={(e) => onChange({ autoRun: e.target.checked })}
              />
              <span>{t("rules.autoRun")}</span>
            </label>
            <div className="flex items-center gap-1">
              <button
                onClick={onTest}
                disabled={state.running}
                className="flex items-center gap-0.5 px-2 py-0.5 rounded"
                style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-secondary)" }}
                title={t("rules.dryRun")}
              >
                <Icon name="science" size={12} />
                {t("rules.test")}
              </button>
              <button
                onClick={onRun}
                disabled={state.running}
                className="flex items-center gap-0.5 px-2 py-0.5 rounded"
                style={{ backgroundColor: "var(--kf-accent)", color: "var(--kf-accent-fg, #fff)" }}
                title={t("rules.runNow")}
              >
                <Icon name="play_arrow" size={12} />
                {t("rules.run")}
              </button>
            </div>
          </div>

          {/* Test result */}
          {state.testResult && (
            <div
              className="rounded px-2 py-1"
              style={{ backgroundColor: "var(--kf-bg-secondary)", border: "1px solid var(--kf-border-soft)" }}
            >
              <div className="flex items-center gap-1" style={{ color: "var(--kf-accent)" }}>
                <Icon name="check_circle" size={12} />
                {t("rules.matched", { count: state.testResult.matched })}
              </div>
              {state.testResult.log.length > 0 && (
                <div className="mt-1 max-h-24 overflow-y-auto text-[10px]" style={{ color: "var(--kf-text-muted)" }}>
                  {state.testResult.log.slice(0, 10).map((l, i) => (
                    <div key={i} className="truncate" title={l.error ?? l.path}>
                      {l.ok ? "✓" : "✗"} {l.path.split(/[\\/]/).pop()}
                      {l.error ? ` (${l.error})` : ""}
                    </div>
                  ))}
                  {state.testResult.log.length > 10 && (
                    <div>{t("rules.andMore", { count: state.testResult.log.length - 10 })}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>{label}</span>
      {children}
    </label>
  );
}

function ActionAddMenu({ onAdd }: { onAdd: (a: RuleAction) => void }) {
  const { t } = useTranslation();
  return (
    <select
      value=""
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        if (v === "move") onAdd({ type: "move", destSubdir: "" });
        else if (v === "addTag") onAdd({ type: "addTag", tag: "" });
        else if (v === "setLabel") onAdd({ type: "setLabel", color: COLOR_LABEL_COLORS[0] });
        e.target.value = "";
      }}
      className="bg-transparent outline-none rounded px-1 py-0.5"
      style={{ border: "1px solid var(--kf-border)", color: "var(--kf-accent)" }}
    >
      <option value="">{t("rules.addOption")}</option>
      <option value="move">{t("rules.actionMove")}</option>
      <option value="addTag">{t("rules.actionAddTag")}</option>
      <option value="setLabel">{t("rules.actionSetLabel")}</option>
    </select>
  );
}

function ActionRow({
  action, onChange, onRemove,
}: {
  action: RuleAction;
  onChange: (next: RuleAction) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 px-1 py-0.5 rounded" style={{ backgroundColor: "var(--kf-bg-secondary)" }}>
      {action.type === "move" && (
        <>
          <Icon name="drive_file_move" size={12} style={{ color: "var(--kf-text-muted)" }} />
          <span style={{ color: "var(--kf-text-muted)", fontSize: 10 }}>→</span>
          <input
            value={action.destSubdir}
            onChange={(e) => onChange({ type: "move", destSubdir: e.target.value })}
            placeholder={t("rules.subfolderPlaceholder")}
            className="flex-1 bg-transparent outline-none rounded px-1 py-0.5"
            style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
          />
        </>
      )}
      {action.type === "addTag" && (
        <>
          <Icon name="sell" size={12} style={{ color: "var(--kf-text-muted)" }} />
          <input
            value={action.tag}
            onChange={(e) => onChange({ type: "addTag", tag: e.target.value })}
            placeholder={t("rules.tagNamePlaceholder")}
            className="flex-1 bg-transparent outline-none rounded px-1 py-0.5"
            style={{ border: "1px solid var(--kf-border)", color: "var(--kf-text-primary)" }}
          />
        </>
      )}
      {action.type === "setLabel" && (
        <>
          <Icon name="label" size={12} style={{ color: "var(--kf-text-muted)" }} />
          <div className="flex items-center gap-1 flex-1">
            {COLOR_LABEL_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => onChange({ type: "setLabel", color: c })}
                className="rounded-full"
                style={{
                  width: 14,
                  height: 14,
                  backgroundColor: c,
                  outline: action.color === c ? "2px solid var(--kf-text-primary)" : undefined,
                  outlineOffset: 1,
                }}
                title={c}
              />
            ))}
          </div>
        </>
      )}
      <button onClick={onRemove} className="opacity-60 hover:opacity-100 flex items-center" title={t("rules.delete")}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}
