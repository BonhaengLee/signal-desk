// 화면에서 쓰는 기본 컴포넌트. 동작·키보드·스크린 리더 처리는 Radix Primitives(ADR-0003)에 맡기고 모양만 입힌다.
// 상태 표시는 Radix 가 붙이는 data-state 값을 CSS 에서 읽는다. 키보드 포커스 링은 CSS :focus-visible 로 그린다.

import { useId, useRef, type CSSProperties, type ReactNode } from 'react';
import * as RSelect from '@radix-ui/react-select';
import * as RSwitch from '@radix-ui/react-switch';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import s from './controls.module.css';

/* ── 셀렉트 ───────────────────────────────────────── */

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className={s.select}>
      <label className={s.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
        <RSelect.Trigger id={id} className={s.selectButton}>
          <RSelect.Value className={s.selectValue} />
          <RSelect.Icon asChild>
            <Chevron />
          </RSelect.Icon>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content className={s.popover} position="popper" sideOffset={4}>
            <RSelect.Viewport className={s.listBox}>
              {options.map((o) => (
                <RSelect.Item key={o.id} value={o.id} textValue={o.label} className={s.option}>
                  <RSelect.ItemText>
                    <span className={s.optionLabel}>{o.label}</span>
                  </RSelect.ItemText>
                </RSelect.Item>
              ))}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </div>
  );
}

function Chevron() {
  return (
    <svg className={s.chevron} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── 단일 선택 세그먼트 (배속처럼 2~4개 중 하나) ───────── */

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  // APG Radio Group: 화살표로 옮기면 선택도 바뀐다. Radix 는 포커스만 옮기므로, 이동 키를 누른 직후의 포커스에서만 선택한다.
  // 마우스는 누를 때 포커스가 먼저 오므로 포커스로 선택하면 끌어서 취소할 수 없다. 마우스 선택은 Radix 의 click 처리에 맡긴다
  const byKey = useRef(false);
  return (
    <div className={s.field}>
      <span className={s.fieldLabel} aria-hidden="true">
        {label}
      </span>
      {/* type="single" 은 radiogroup/radio 로 그려진다. 빈 값('')은 선택 해제라 무시해 항상 하나가 선택되게 한다 */}
      <ToggleGroup.Root
        type="single"
        aria-label={label}
        className={s.segmented}
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        onKeyDownCapture={(e) => {
          byKey.current = MOVE_KEYS.has(e.key);
        }}
      >
        {options.map((o) => (
          <ToggleGroup.Item
            key={o.id}
            value={o.id}
            className={s.segment}
            onFocus={() => {
              if (byKey.current && o.id !== value) onChange(o.id);
              byKey.current = false;
            }}
          >
            {o.label}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </div>
  );
}

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/* ── 필터 칩 (여러 개 선택) ─────────────────────────── */

export type Chip = { id: string; label: string; count?: number; tone?: string; color?: string };

export function ChipGroup({
  label,
  chips,
  selected,
  onChange,
}: {
  label: string;
  chips: readonly Chip[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const groupId = useId();
  return (
    <ToggleGroup.Root
      type="multiple"
      aria-label={label}
      className={s.chips}
      value={[...selected]}
      onValueChange={(v) => onChange(new Set(v))}
    >
      {chips.map((c) => {
        const countId = `${groupId}-${c.id}-count`;
        return (
          <ToggleGroup.Item
            key={c.id}
            value={c.id}
            className={s.chip}
            // 이름은 라벨만 둔다. 건수까지 이름에 넣으면 이벤트가 올 때마다 이름이 바뀌어, 이름으로 버튼을 찾는 에이전트가 놓친다.
            // 건수는 설명으로 붙인다 ("에러", 설명 "9건")
            aria-label={c.label}
            aria-describedby={c.count !== undefined ? countId : undefined}
            data-tone={c.tone}
            style={c.color ? ({ '--chip-dot': c.color } as CSSProperties) : undefined}
          >
            <span className={s.chipDot} aria-hidden="true" />
            {c.label}
            {c.count !== undefined && (
              <span id={countId} className={s.chipCount}>
                {c.count}
                <span className={s.srOnly}>건</span>
              </span>
            )}
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}

/* ── 스위치 ─────────────────────────────────────────── */

/** label 로 감싸 글자를 눌러도 켜지고, 글자가 스위치의 이름이 된다 */
export function Switch({ children, isSelected, onChange }: { children: ReactNode; isSelected: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={s.switch}>
      <RSwitch.Root className={s.track} checked={isSelected} onCheckedChange={onChange}>
        <RSwitch.Thumb className={s.thumb} />
      </RSwitch.Root>
      {children}
    </label>
  );
}

/* ── 뱃지 ───────────────────────────────────────────── */

export type Tone = 'error' | 'warn' | 'ok' | 'info' | 'deploy' | 'neutral';

export function Badge({ tone, children, dot, pulse }: { tone: Tone; children: ReactNode; dot?: boolean; pulse?: boolean }) {
  return (
    <span className={s.badge} data-tone={tone}>
      {dot && <span className={s.badgeDot} data-pulse={pulse || undefined} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** 화면에는 안 보이지만 스크린 리더와 DOM 을 읽는 에이전트는 읽는 글자 */
export function VisuallyHidden({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className={s.srOnly}>
      {children}
    </span>
  );
}

/* ── 카드 ───────────────────────────────────────────── */

export function Card({
  title,
  meta,
  actions,
  children,
  className,
  bodyClassName,
  labelledBy,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  labelledBy: string;
}) {
  return (
    <section className={`${s.card} ${className ?? ''}`} aria-labelledby={labelledBy}>
      <header className={s.cardHead}>
        <h2 id={labelledBy} className={s.cardTitle}>
          {title}
        </h2>
        {meta && <span className={s.cardMeta}>{meta}</span>}
        {actions && <div className={s.cardActions}>{actions}</div>}
      </header>
      <div className={`${s.cardBody} ${bodyClassName ?? ''}`}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      {icon && <div className={s.emptyIcon}>{icon}</div>}
      <p className={s.emptyTitle}>{title}</p>
      {children && <p className={s.emptyText}>{children}</p>}
    </div>
  );
}
