function setupOrderForm(form){
  if(!form) return;
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const status=form.querySelector('.form-status');
    const button=form.querySelector('button[type="submit"]');
    const data=Object.fromEntries(new FormData(form).entries());
    if(!String(data.name||'').trim() || !String(data.phone||'').trim()) return;

    status.className='form-status';
    status.textContent='Надсилаємо замовлення…';
    if(button){button.disabled=true;button.style.opacity='.7';}

    const params=new URLSearchParams(window.location.search);
    data.source=params.get('utm_source')||'Прямий перехід';
    data.medium=params.get('utm_medium')||'';
    data.campaign=params.get('utm_campaign')||'';
    data.content=params.get('utm_content')||'';

    try{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),15000);
      const r=await fetch('/api/order',{
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify(data),
        signal:controller.signal
      });
      clearTimeout(timeout);
      const result=await r.json().catch(()=>({}));
      if(!r.ok||!result.ok) throw new Error(result.error||'Помилка');
      if(typeof fbq==='function') fbq('track','Lead');
      status.className='form-status success';
      status.textContent='Дякуємо! Менеджер зв’яжеться з вами для підтвердження.';
      form.reset();
    }catch(err){
      status.className='form-status error';
      status.textContent=err.name==='AbortError' ? 'Сервер відповідає занадто довго. Спробуйте ще раз.' : 'Не вдалося відправити заявку. Спробуйте ще раз.';
    }finally{
      if(button){button.disabled=false;button.style.opacity='';}
    }
  });
}

setupOrderForm(document.getElementById('heroForm'));
setupOrderForm(document.getElementById('bottomForm'));

function scrollToBottomOrder(){
  document.getElementById('bottom-order')?.scrollIntoView({behavior:'smooth',block:'center'});
}
document.querySelectorAll('[data-scroll-bottom]').forEach(btn=>btn.addEventListener('click',scrollToBottomOrder));

autoTimer();
function autoTimer(){
  const tick=()=>{
    const now=new Date();
    const end=new Date(now); end.setHours(23,59,59,999);
    const remaining=Math.max(0,Math.floor((end-now)/1000));
    const h=String(Math.floor(remaining/3600)).padStart(2,'0');
    const m=String(Math.floor((remaining%3600)/60)).padStart(2,'0');
    const s=String(remaining%60).padStart(2,'0');
    const el=document.getElementById('timerHero'); if(el) el.textContent=`${h}:${m}:${s}`;
  };
  tick();setInterval(tick,1000);
}

const lightbox=document.getElementById('lightbox');
const lightboxImg=document.getElementById('lightboxImg');
document.querySelectorAll('.gallery-item').forEach(item=>item.addEventListener('click',()=>{
  if(!lightbox||!lightboxImg) return;
  lightboxImg.src=item.querySelector('img').src;
  lightboxImg.alt=item.querySelector('img').alt;
  lightbox.classList.add('open');
}));
function closeLightbox(){lightbox?.classList.remove('open');if(lightboxImg) lightboxImg.src='';}
document.querySelector('.lightbox-close')?.addEventListener('click',closeLightbox);
lightbox?.addEventListener('click',e=>{if(e.target===lightbox) closeLightbox();});
document.addEventListener('keydown',e=>{if(e.key==='Escape') closeLightbox();});
