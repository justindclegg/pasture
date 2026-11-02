(() => {
  const form = document.getElementById('ask');
  if (!form) return;
  const status = form.querySelector('.ask-status');
  const btn = form.querySelector('button');
  const input = form.querySelector('textarea');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    btn.disabled = true;
    status.textContent = 'The agent is designing your space. This usually takes under a minute.';
    try {
      const r = await fetch('/api/spaces/generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, visibility: form.visibility.value }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Something went wrong');
      location.href = data.path;
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
    }
  });
})();
