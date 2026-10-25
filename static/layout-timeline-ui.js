import { node, action } from './layout-editor-ui.js';

const labels = {
  position:'位置',rotation:'旋转',scale:'缩放',quaternion:'镜头方向',focal:'焦距',
  visible:'显示',parentId:'挂接父级',pose:'姿态',hands:'手势',body:'人物比例',
  face:'脸部',material:'材质',rail:'相机轨道',progress:'轨道进度',color:'颜色',
  roughness:'粗糙度',metalness:'金属度',opacity:'透明度',eyeOpen:'睁眼',mouthOpen:'张嘴',mouthSmile:'微笑'
};
const propertyLabel = path => path.split('.').map(part => labels[part] || ({0:'X',1:'Y',2:'Z'})[part] || part).join(' · ');

export class TimelineUI {
  constructor(mount, api) {
    this.mount=mount;
    this.api=api;
    this.expanded=false;
    this.everHadTracks=false;
    this.selectedKeys=new Map();
    this.closedGroups=new Set();
    this.zoom=1;
    this.scene=null;
    this.time=0;
    this.create();
  }

  create() {
    const header=node('div','previs-timeline-header');
    this.mount.classList.add('collapsed');
    this.expand=action('展开时间线',()=>{
      this.expanded=!this.expanded;
      this.mount.classList.toggle('collapsed',!this.expanded);
      this.expand.textContent=this.expanded?'收起时间线':'展开时间线';
    },'layout-timeline-expand');
    this.play=action('播放 Space',()=>this.api.play(),'layout-play');
    this.quick=action('K 全部 + 当前视角',()=>this.api.keyAll(),'layout-key-add','previs-button primary-quiet');
    const duration=node('label','previs-time-control');
    duration.append(node('span','','时长'));
    this.duration=node('input');this.duration.type='number';this.duration.min=1;this.duration.max=300;this.duration.step=.1;this.duration.id='layout-sequence-duration';
    this.duration.addEventListener('change',()=>{if(this.duration.reportValidity())this.api.duration(Number(this.duration.value));});
    duration.append(this.duration,node('span','','秒'));
    const fps=node('label','previs-time-control');fps.append(node('span','','FPS'));
    this.fps=node('input');this.fps.type='number';this.fps.min=1;this.fps.max=60;this.fps.step=1;this.fps.id='layout-sequence-fps';
    this.fps.addEventListener('change',()=>{if(this.fps.reportValidity())this.api.fps(Number(this.fps.value));});fps.append(this.fps);
    const zoom=node('select');zoom.title='时间线缩放';zoom.id='layout-timeline-zoom';
    for(const [value,label] of [[1,'全长'],[2,'2×'],[4,'4×'],[8,'8×']]){const option=node('option','',label);option.value=value;zoom.append(option);}
    zoom.addEventListener('change',()=>{this.zoom=Number(zoom.value);this.render(this.scene,this.time);});
    this.timeOutput=node('output');this.timeOutput.id='layout-time-value';
    header.append(node('strong','','Sequence'),this.expand,this.play,this.quick,duration,fps,zoom,this.timeOutput);
    const transport=node('div','previs-transport');
    this.timeInput=node('input');this.timeInput.id='layout-time';this.timeInput.type='range';this.timeInput.min=0;this.timeInput.step=.001;
    this.timeInput.setAttribute('aria-label','动画时间线');
    this.timeInput.addEventListener('input',()=>this.api.seek(Number(this.timeInput.value)));
    transport.append(this.timeInput);
    this.scroll=node('div','previs-tracks-scroll');
    this.scroll.id='layout-tracks';
    this.rows=node('div','previs-tracks-content');
    this.scroll.append(this.rows);
    const selection=node('div','previs-key-selection');
    this.selectionLabel=node('span','','未选择关键帧');
    this.keyTime=node('input');this.keyTime.type='number';this.keyTime.min=0;this.keyTime.step=.001;this.keyTime.id='layout-key-time';this.keyTime.title='选中关键帧时间';
    this.keyTime.addEventListener('change',()=>{
      const first=this.selectedKeys.values().next().value;
      if(!first||!this.keyTime.reportValidity())return;
      const old=this.findKey(first),delta=Number(this.keyTime.value)-(old?.time || 0);
      this.api.moveKeys([...this.selectedKeys.values()].map(item=>({...item,time:Math.max(0,Math.min(this.scene.sequence.duration,this.findKey(item).time+delta))})));
    });
    this.interpolation=node('select');this.interpolation.id='layout-key-interpolation';this.interpolation.title='选中关键帧插值';
    for(const [value,label] of [['linear','线性'],['smooth','平滑'],['step','保持']]){const option=node('option','',label);option.value=value;this.interpolation.append(option);}
    this.interpolation.addEventListener('change',()=>this.api.interpolation([...this.selectedKeys.values()],this.interpolation.value));
    this.delete=action('删除选中帧',()=>this.deleteSelected(),'layout-key-delete','previs-button danger');
    selection.append(this.selectionLabel,this.keyTime,this.interpolation,this.delete,node('span','previs-help','Shift 多选 · 拖动移动 · 删除可撤销'));
    this.mount.replaceChildren(header,transport,this.scroll,selection);
  }

  findKey(item) {
    return this.scene?.sequence.tracks.find(track=>track.id===item.trackId)?.keys.find(key=>key.id===item.keyId);
  }

  selectedCount(){return this.selectedKeys.size;}
  resetForScene(){this.everHadTracks=false;this.expanded=false;this.selectedKeys.clear();this.mount.classList.add('collapsed');this.expand.textContent='展开时间线';}
  deleteSelected(){if(this.selectedKeys.size)this.api.removeKeys([...this.selectedKeys.values()]);this.selectedKeys.clear();}

  selectKey(track,key,additive=false) {
    if(!additive)this.selectedKeys.clear();
    const id=track.id+':'+key.id;
    if(additive&&this.selectedKeys.has(id))this.selectedKeys.delete(id);
    else this.selectedKeys.set(id,{trackId:track.id,keyId:key.id});
    this.api.seek(key.time);
    this.render(this.scene,key.time);
  }

  render(scene,time) {
    if(!scene)return;
    if(scene.sequence.tracks.length&&!this.everHadTracks){this.everHadTracks=true;this.expanded=true;this.mount.classList.remove('collapsed');this.expand.textContent='收起时间线';}
    this.scene=scene;
    this.time=time;
    this.duration.value=scene.sequence.duration;
    this.fps.value=scene.sequence.fps || 24;
    this.timeInput.max=scene.sequence.duration;
    this.keyTime.max=scene.sequence.duration;
    for(const [id,item] of this.selectedKeys)if(!this.findKey(item))this.selectedKeys.delete(id);
    const scrollTop=this.scroll.scrollTop,scrollLeft=this.scroll.scrollLeft;
    this.rows.replaceChildren();
    this.rows.style.minWidth=Math.max(650,scene.sequence.duration*8*this.zoom)+'px';
    const groups=new Map();
    for(const track of scene.sequence.tracks){if(!groups.has(track.targetId))groups.set(track.targetId,[]);groups.get(track.targetId).push(track);}
    if(!groups.size)this.rows.append(node('div','previs-timeline-empty','还没有动画。调整场景后按 K，或用属性右侧的 K 单独记录。相机、角色、表情、材质和挂接关系都可以记录。'));
    for(const [targetId,tracks] of groups){
      const title=targetId==='camera'?'拍摄相机':scene.objects.find(object=>object.id===targetId)?.label || targetId;
      const group=node('div','previs-track-group');
      const toggle=action((this.closedGroups.has(targetId)?'▸ ':'▾ ')+title,()=>{
        if(this.closedGroups.has(targetId))this.closedGroups.delete(targetId);else this.closedGroups.add(targetId);
        this.render(this.scene,this.time);
      },'','previs-track-group-title');
      group.append(toggle,node('span','previs-track-count',tracks.length+' 轨'));
      this.rows.append(group);
      if(this.closedGroups.has(targetId))continue;
      for(const track of tracks){
        const row=node('div','previs-track-row');row.dataset.trackId=track.id;
        const label=node('div','previs-track-label',propertyLabel(track.property));label.title=track.property;
        const strip=node('div','previs-key-strip');strip.dataset.trackId=track.id;
        strip.addEventListener('pointerdown',event=>{
          if(event.target.closest('button'))return;
          const box=strip.getBoundingClientRect();
          this.selectedKeys.clear();
          this.api.seek(Math.max(0,Math.min(scene.sequence.duration,(event.clientX-box.left)/box.width*scene.sequence.duration)));
        });
        const playhead=node('span','previs-track-playhead');playhead.style.left=time/scene.sequence.duration*100+'%';strip.append(playhead);
        for(const key of track.keys){
          const selected=this.selectedKeys.has(track.id+':'+key.id);
          const keyButton=node('button','previs-key-diamond'+(selected?' selected':''));keyButton.type='button';keyButton.style.left=key.time/scene.sequence.duration*100+'%';keyButton.dataset.keyId=key.id;
          keyButton.title=`${title} / ${propertyLabel(track.property)} · ${key.time.toFixed(3)} 秒`;
          keyButton.setAttribute('aria-label',keyButton.title);
          keyButton.addEventListener('pointerdown',event=>this.beginDrag(event,track,key,strip));
          strip.append(keyButton);
        }
        row.append(label,strip);this.rows.append(row);
      }
    }
    this.scroll.scrollTop=scrollTop;this.scroll.scrollLeft=scrollLeft;
    const selected=[...this.selectedKeys.values()],first=selected[0],key=first&&this.findKey(first);
    this.selectionLabel.textContent=selected.length?`已选 ${selected.length} 帧`:'未选择关键帧';
    this.keyTime.disabled=this.interpolation.disabled=this.delete.disabled=!key;
    this.keyTime.value=key?.time ?? 0;
    const track=first&&scene.sequence.tracks.find(track=>track.id===first.trackId);
    this.interpolation.value=key?.interpolation || track?.interpolation || 'linear';
    this.setTime(time);
  }

  beginDrag(event,track,key,strip){
    if(event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    const id=track.id+':'+key.id;
    if(!this.selectedKeys.has(id)){
      if(!event.shiftKey&&!event.ctrlKey&&!event.metaKey)this.selectedKeys.clear();
      this.selectedKeys.set(id,{trackId:track.id,keyId:key.id});
    }else if(event.shiftKey){this.selectedKeys.delete(id);this.render(this.scene,this.time);return;}
    const selection=[...this.selectedKeys.values()],original=selection.map(item=>({...item,time:this.findKey(item).time})),start=event.clientX,width=strip.getBoundingClientRect().width;
    const lower=-Math.min(...original.map(item=>item.time)),upper=this.scene.sequence.duration-Math.max(...original.map(item=>item.time));
    let delta=0,moved=false;
    const move=next=>{
      delta=(next.clientX-start)/width*this.scene.sequence.duration;
      const frame=1/(this.scene.sequence.fps || 24);delta=Math.round(delta/frame)*frame;
      delta=Math.max(lower,Math.min(upper,delta));moved ||= Math.abs(next.clientX-start)>3;
      for(const item of original){const button=this.rows.querySelector(`[data-track-id="${CSS.escape(item.trackId)}"] [data-key-id="${CSS.escape(item.keyId)}"]`);if(button){button.classList.add('selected');button.style.left=(item.time+delta)/this.scene.sequence.duration*100+'%';}}
    };
    const finish=()=>{
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);
      if(moved)this.api.moveKeys(original.map(item=>({...item,time:item.time+delta})));else {this.api.seek(key.time);this.render(this.scene,key.time);}
    };
    const cancel=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);this.render(this.scene,this.time);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',cancel,{once:true});
  }

  setTime(time){
    this.time=time;this.timeInput.value=time;
    this.timeOutput.textContent=`${time.toFixed(2)} / ${this.scene?.sequence.duration.toFixed(1) || '0.0'} 秒`;
    if(this.scene)for(const playhead of this.rows.querySelectorAll('.previs-track-playhead'))playhead.style.left=time/this.scene.sequence.duration*100+'%';
  }
  setPlaying(playing){this.play.textContent=playing?'暂停 Space':'播放 Space';}
}
