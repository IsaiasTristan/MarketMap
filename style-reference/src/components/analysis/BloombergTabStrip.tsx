"use client";

export interface BloombergTabItem {
  key: string;
  label: string;
  /** Optional count badge (e.g. alert count) */
  badge?: number;
}

interface BloombergTabStripProps {
  tabs: BloombergTabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  /** `chrome` = inactive text on maroon (unused in Factors); `default` = gray on black */
  variant?: "default" | "chrome";
}

export function BloombergTabStrip({
  tabs,
  activeKey,
  onChange,
  variant = "default",
}: BloombergTabStripProps) {
  return (
    <div className="bb-tab-row" role="tablist">
      {tabs.map((t) => {
        const active = t.key === activeKey;
        const chrome = variant === "chrome";
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`bb-tab${active ? " bb-tab--active" : ""}${chrome ? " bb-tab--chrome" : ""}`}
          >
            {t.label}
            {t.badge != null && t.badge > 0 ? (
              <span
                style={{
                  marginLeft: 4,
                  background: "var(--bb-red)",
                  color: "#fff",
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "0 4px",
                  verticalAlign: "middle",
                }}
              >
                {t.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
