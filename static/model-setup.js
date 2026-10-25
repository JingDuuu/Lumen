/* Local inventory only on startup. Network downloads require an explicit click. */
(() => {
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
  const gib=bytes=>(bytes/1024**3).toFixed(1)+' GiB';
  let inventory=null,timer=null;
  const dialog=element('dialog',null,'model-setup-dialog');dialog.id='model-setup-dialog';
  const heading=element('div',null,'model-setup-heading');heading.append(element('h2','模型与本地安装'));
  const close=element('button','关闭','btn');close.onclick=()=>dialog.close();heading.append(close);
  const info=element('p','Lumen 的画板、素材库和 3D 预演可以先用。生成视频需要本地 ComfyUI 和 H3 模型。');
  const paths=element('p',null,'model-setup-paths'),list=element('div',null,'model-setup-list');
  const license=element('label',null,'model-setup-license'),accepted=element('input');accepted.type='checkbox';
  const link=element('a','MiniMax H3 模型许可');link.href='https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE';link.target='_blank';link.rel='noopener';
  license.append(accepted,document.createTextNode('我已阅读并确认适用的 '),link);
  const note=element('p','模型采用独立的 Community License，包含适用地区与商业使用条件，不随 Lumen 的源码许可授权。文件来自官方固定版本；下载完成后核对 SHA-256。', 'model-setup-note');
  const progress=element('progress');progress.max=1;progress.value=0;
  const status=element('p','准备检查本地文件…','model-setup-status');status.setAttribute('role','status');
  const actions=element('div',null,'model-setup-actions'),install=element('button','安装所选模型','btn primary'),cancel=element('button','暂停下载','btn');
  const refresh=element('button','重新检查','btn');refresh.onclick=()=>update(true);cancel.onclick=()=>call('/api/models/cancel',{});
  install.onclick=async()=>{
    if(!accepted.checked){status.textContent='请先阅读并确认模型许可。';return;}
    const ids=[...list.querySelectorAll('input:checked')].map(input=>input.value);
    if(!ids.length){status.textContent='请选择需要安装或校验的文件。';return;}
    await call('/api/models/install',{models:ids,accept_license:true});
  };
  actions.append(install,cancel,refresh);dialog.append(heading,info,paths,list,license,note,progress,status,actions);document.body.append(dialog);
  const button=element('button','模型与安装','btn');button.id='model-setup-open';button.title='检查模型、安装进度和本地路径';button.onclick=()=>{dialog.showModal();update(true);};
  document.querySelector('.app-header')?.append(button);
  async function call(url,body){try{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Error(value.error||'操作失败');inventory=value;render(false);poll();}catch(error){status.textContent=error.message;}}
  function render(rebuild){
    if(rebuild){
      list.replaceChildren();
      for(const model of inventory.models){
        const row=element('label',null,'model-setup-row'),checkbox=element('input');checkbox.type='checkbox';checkbox.value=model.id;checkbox.checked=!model.present;
        const text=element('span');text.append(element('strong',model.label),element('small',`${gib(model.size)} · ${model.present?'文件已存在，安装按钮可完整校验':model.partial_bytes?'已下载 '+gib(model.partial_bytes)+'，可续传':'尚未安装'}`));row.append(checkbox,text);list.append(row);
      }
    }
    const job=inventory.job;
    for(const [index,row] of [...list.children].entries()){
      const model=inventory.models[index];
      row.querySelector('small').textContent=`${gib(model.size)} · ${model.present?'文件已存在，安装按钮可完整校验':model.partial_bytes?'已下载 '+gib(model.partial_bytes)+'，可续传':'尚未安装'}`;
    }
    paths.textContent=`模型目录：${inventory.models_dir}\n可用空间：${gib(inventory.free_bytes)}\n${inventory.engine_installed?'生成引擎已配置':'生成引擎未配置：请双击 Setup-Lumen.cmd 安装依赖，或在 lumen.local.json 指向已有引擎。'}`;
    const labels={idle:'请选择模型。全套约 '+gib(inventory.models.reduce((sum,m)=>sum+m.size,0))+'，只安装时主动联网。',starting:'正在准备',downloading:'正在下载',verifying:'正在校验 SHA-256',retrying:'连接中断，正在续传',cancelling:'正在暂停，保留已下载内容',cancelled:'已暂停，可继续安装',ready:'安装与完整校验完成',failed:'安装未完成'};
    const bytes=job.stage==='verifying'?job.verified_bytes:job.downloaded_bytes;
    progress.value=job.expected_bytes?Math.min(1,(bytes||0)/job.expected_bytes):0;
    status.textContent=[labels[job.stage]||job.stage,job.label,job.expected_bytes?`${gib(bytes||0)} / ${gib(job.expected_bytes)}`:'',job.bytes_per_second?`${(job.bytes_per_second/1024**2).toFixed(1)} MiB/s`:'',job.eta_seconds?`约 ${Math.ceil(job.eta_seconds/60)} 分钟`:'',job.error].filter(Boolean).join(' · ');
    install.disabled=!!job.active;cancel.disabled=!job.active;for(const checkbox of list.querySelectorAll('input'))checkbox.disabled=!!job.active;
  }
  function poll(){clearTimeout(timer);if(dialog.open&&inventory?.job.active)timer=setTimeout(()=>update(false),1000);}
  async function update(rebuild){try{const response=await fetch('/api/models');if(!response.ok)throw Error('无法读取安装状态');inventory=await response.json();render(rebuild);poll();}catch(error){status.textContent=error.message;}}
  dialog.addEventListener('close',()=>clearTimeout(timer));
  update(true).then(()=>{if(inventory&&(!inventory.engine_installed||inventory.models.some(model=>!model.present))&&!localStorage.getItem('lumen-model-onboarding-seen')){localStorage.setItem('lumen-model-onboarding-seen','1');dialog.showModal();}});
})();
