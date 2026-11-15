/* Numeric edits share one transaction from pointer down to pointer up. */
export function numericControl(input, api, change) {
  const wrap=document.createElement('div');wrap.className='previs-number';
  const bar=document.createElement('span');bar.className='previs-number-bar';bar.setAttribute('aria-hidden','true');
  wrap.append(input,bar);
  input.title='左右拖动调节 · 中键按住打开倍率阶梯 · 双击输入';
  const step=Number(input.step)||.01,min=Number(input.min),max=Number(input.max);
  const updateBar=()=>{const value=Number(input.value),range=max-min;wrap.style.setProperty('--amount',`${range>0&&range<1001?Math.max(0,Math.min(100,(value-min)/range*100)):50}%`);};
  updateBar();input.addEventListener('input',updateBar);
  let drag=null,ladder=null;
  const multipliers=[100,10,1,.1];
  const finish=cancel=>{
    if(!drag)return;
    const active=drag.active;drag=null;ladder?.remove();ladder=null;wrap.classList.remove('scrubbing');document.documentElement.classList.remove('previs-scrubbing');
    window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancelPointer,true);window.removeEventListener('keydown',escape,true);window.removeEventListener('blur',blur);
    if(active)api.endGesture(cancel);
  };
  const move=event=>{
    if(!drag)return;
    if(!drag.active&&Math.abs(event.clientX-drag.x)<4)return;
    event.preventDefault();event.stopPropagation();
    if(!drag.active){drag.active=true;api.beginGesture();wrap.classList.add('scrubbing');document.documentElement.classList.add('previs-scrubbing');}
    let multiplier=1;
    if(drag.middle){const index=Math.max(0,Math.min(3,2+Math.round((event.clientY-drag.y)/30)));multiplier=multipliers[index];for(const [i,row] of [...ladder.children].entries())row.classList.toggle('active',i===index);}
    const next=Math.max(min,Math.min(max,drag.value+(event.clientX-drag.lastX)*step*multiplier));
    drag.lastX=event.clientX;drag.value=next;
    input.value=String(Number(next.toFixed(6)));updateBar();change(Number(input.value));
  };
  const up=event=>{if(drag?.active){event.preventDefault();event.stopPropagation();}finish(false);};
  const cancelPointer=()=>finish(true),blur=()=>finish(false);
  const escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(true);}};
  input.addEventListener('pointerdown',event=>{
    if(event.button!==0&&event.button!==1)return;
    drag={x:event.clientX,lastX:event.clientX,y:event.clientY,value:Number(input.value)||0,middle:event.button===1,active:false};
    if(drag.middle){
      event.preventDefault();ladder=document.createElement('div');ladder.className='previs-value-ladder';ladder.setAttribute('role','status');
      for(const value of multipliers){const row=document.createElement('div');row.textContent=`× ${value}`;row.classList.toggle('active',value===1);ladder.append(row);}
      const dialog=input.closest('dialog')||document.body;dialog.append(ladder);ladder.style.left=`${Math.min(innerWidth-108,event.clientX+22)}px`;ladder.style.top=`${Math.max(8,Math.min(innerHeight-150,event.clientY-74))}px`;
      drag.active=true;api.beginGesture();wrap.classList.add('scrubbing');document.documentElement.classList.add('previs-scrubbing');
    }
    window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',cancelPointer,true);window.addEventListener('keydown',escape,true);window.addEventListener('blur',blur);
  });
  input.addEventListener('auxclick',event=>event.preventDefault());
  input.addEventListener('dblclick',()=>{input.focus();input.select();});
  return wrap;
}
