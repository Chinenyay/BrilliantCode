const setupButton = document.getElementById('setup-api-keys') as HTMLButtonElement | null;
const statusEl = document.getElementById('setup-status') as HTMLElement | null;

function setStatus(message: string, kind: 'info' | 'error' = 'info'): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

async function refreshStatus(): Promise<void> {
  if (!window.apiKeys?.status) {
    setStatus('API key bridge unavailable.', 'error');
    if (setupButton) setupButton.disabled = true;
    return;
  }

  try {
    const res = await window.apiKeys.status();
    if (!res?.ok || !res.status) {
      setStatus(res?.error || 'Unable to read API key status.', 'error');
      return;
    }
    const openai = res.status.openai?.configured === true;
    const openaiCompat = res.status.openaiCompat?.configured === true;
    const anthropic = res.status.anthropic?.configured === true;
    const summary = [
      `OpenAI: ${openai ? 'configured' : 'missing'}`,
      `OpenAI-compatible: ${openaiCompat ? 'configured' : 'missing'}`,
      `Anthropic: ${anthropic ? 'configured' : 'missing'}`,
    ].join(' · ');
    setStatus(summary, 'info');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to read API key status.';
    setStatus(message, 'error');
  }
}

function openDialog(): void {
  try { window.apiKeys?.showDialog?.(); } catch {}
}

if (setupButton) {
  setupButton.addEventListener('click', () => openDialog());
}

void refreshStatus();
