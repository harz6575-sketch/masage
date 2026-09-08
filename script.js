const scrollButtons = document.querySelectorAll('[data-scroll-order]');
scrollButtons.forEach(btn => btn.addEventListener('click', () => {
  document.getElementById('order').scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

// Таймер автоматично рахує до кінця поточного дня.
// Дату на сторінці не показуємо, а о 00:00 відлік автоматично починається заново.
function tick(){
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const remaining = Math.max(0, Math.floor((end.getTime() - now.getTime()) / 1000));
  const h = String(Math.floor(remaining / 3600)).padStart(2,'0');
  const m = String(Math.floor((remaining % 3600) / 60)).padStart(2,'0');
  const s = String(remaining % 60).padStart(2,'0');
  const value = `${h}:${m}:${s}`;
  const timer = document.getElementById('timerBand');
  const heroTimer = document.getElementById('timerHero');
  if (timer) timer.textContent = value;
  if (heroTimer) heroTimer.textContent = value;
}
tick();
setInterval(tick, 1000);

const form = document.getElementById('orderForm');
const status = document.getElementById('formStatus');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.className = 'form-status';
  status.textContent = 'Надсилаємо замовлення…';
  const data = Object.fromEntries(new FormData(form).entries());
  const params = new URLSearchParams(window.location.search);
  data.source = params.get('utm_source') || 'Прямий перехід';
  data.medium = params.get('utm_medium') || '';
  data.campaign = params.get('utm_campaign') || '';
  data.content = params.get('utm_content') || '';
  try {
    const r = await fetch('/api/order', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(data)
    });
    const result = await r.json();
    if (!r.ok || !result.ok) throw new Error(result.error || 'Помилка');
    status.className = 'form-status success';
    status.textContent = 'Дякуємо! Замовлення прийнято. Менеджер зв’яжеться з вами.';
    form.reset();
  } catch (err) {
    status.className = 'form-status error';
    status.textContent = 'Не вдалося відправити заявку. Спробуйте ще раз.';
  }
});
