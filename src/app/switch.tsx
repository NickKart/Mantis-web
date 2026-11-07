// Переключатель – отдельно от ui.tsx, чтобы блок подписки можно было подключить к старой версии без ядра нового интерфейса.
export function Switch(p: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" class="switch" role="switch" aria-checked={p.on} aria-label={p.label} disabled={p.disabled} onClick={() => p.onChange(!p.on)}>
      <span />
    </button>
  );
}
