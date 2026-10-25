/* Native-sized editor controls. Scene ownership stays in layout.js. */
export const node = (tag, className = '', text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

export function action(label, run, id = '', className = 'previs-button') {
  const element = node('button', className, label);
  element.type = 'button';
  if (id) element.id = id;
  element.addEventListener('click', run);
  return element;
}

export function icon(name) {
  const paths = {
    visible: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    hidden: 'M3 3l18 18M9 5a11 11 0 0 1 3 0c7 0 10 7 10 7a19 19 0 0 1-4 5M6 6a19 19 0 0 0-4 6s3 7 10 7a13 13 0 0 0 5-1',
    lock: 'M6 10h12v11H6V10Zm2 0V6a4 4 0 1 1 8 0v4',
    unlock: 'M6 10h12v11H6V10Zm2 0V6a4 4 0 0 1 7-2',
    group: 'M3 5h7l2 3h9v13H3V5Z',
    object: 'm12 2 9 5v10l-9 5-9-5V7l9-5Zm-9 5 9 5 9-5m-9 5v10',
    reset: 'M5 8a8 8 0 1 1-1 7M5 3v5h5',
    expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    close: 'm6 6 12 12M6 18 18 6',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('previs-icon');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name] || paths.object);
  svg.append(path);
  return svg;
}

function iconAction(name, label, run) {
  const button = action('', run, '', 'previs-icon-button');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  return button;
}

function choices(values, value) {
  return values.map(entry => {
    const option = node('option', '', entry.label);
    option.value = entry.id;
    option.selected = String(entry.id) === String(value);
    return option;
  });
}

export class EditorUI {
  constructor(mount, api, catalogs) {
    this.api = api;
    this.catalogs = catalogs;
    this.inspectorSignature = '';
    this.mount = mount;
    this.createShell();
  }

  createShell() {
    const api = this.api;
    const header = node('header', 'previs-header');
    const brand = node('div', 'previs-brand');
    const image = node('img');
    image.src = '/static/lumen-mark.svg';
    image.alt = '';
    brand.append(image, node('strong', '', 'Lumen 3D'), node('span', '', '构图 · 预演'));
    this.fileActions = node('div', 'previs-file-actions');
    this.fileActions.id = 'layout-file-actions';
    const windowActions = node('div', 'previs-window-actions');
    windowActions.append(
      action('撤销', () => api.undo(), 'layout-undo'),
      action('重做', () => api.redo(), 'layout-redo'),
      iconAction('expand', '切换系统全屏', () => api.fullscreen()),
      action('回到画板', () => api.close(), 'layout-close')
    );
    header.append(brand, this.fileActions, windowActions);

    const workspace = node('div', 'previs-workspace');
    workspace.id = 'layout-workspace';
    const left = node('aside', 'previs-left');
    const tabs = node('div', 'previs-tabs');
    tabs.append(action('场景层级', () => this.setLeftTab('objects'), 'layout-outliner-tab'), action('素材库', () => this.setLeftTab('assets'), 'layout-assets-tab'));
    this.outlinerPanel = node('section', 'previs-outliner-panel');
    const outlinerTools = node('div', 'previs-outliner-tools');
    outlinerTools.append(action('建组', () => api.group(), 'layout-group'), action('复制', () => api.duplicate(), 'layout-duplicate'), action('删除', () => api.remove(), 'layout-delete'));
    outlinerTools.querySelector('#layout-delete').title='删除选中对象与原始子级，可撤销恢复';
    this.outliner = node('div', 'previs-outliner');
    this.outliner.id = 'layout-object-list';
    this.outliner.setAttribute('role', 'tree');
    this.parentSelect = node('select');
    this.parentSelect.id = 'layout-parent';
    this.parentSelect.setAttribute('aria-label', '挂接父级');
    this.parentSelect.addEventListener('change', () => api.reparent(this.parentSelect.value || null));
    const attachHint = node('p', 'previs-help', '拖到另一对象上挂接；保持世界位置。Ctrl / Shift 多选。');
    this.outlinerPanel.append(outlinerTools, this.outliner, node('label', 'previs-subtitle', '挂接到'), this.parentSelect, attachHint);
    this.assetPanel = node('section', 'previs-assets-panel');
    const search = node('input');
    search.type = 'search';
    search.placeholder = '搜索人物、家具、道具…';
    search.id = 'layout-asset-search';
    search.addEventListener('input', () => this.renderAssets());
    this.assetCategory = node('select');
    this.assetCategory.id = 'layout-asset-category';
    const names = {people:'人物',furniture:'家具',architecture:'建筑',props:'道具',primitives:'基础形体',outdoor:'室外',lighting:'灯光与相机'};
    this.assetCategory.append(...choices([{id:'all',label:'全部素材'}, ...new Set(this.catalogs.assets.map(item => item.category))].map(item => typeof item === 'string' ? {id:item,label:names[item] || item} : item), 'all'));
    this.assetCategory.addEventListener('change', () => this.renderAssets());
    this.assetGrid = node('div', 'previs-asset-grid');
    this.assetGrid.id = 'layout-asset-catalog';
    this.assetPanel.append(search, this.assetCategory, this.assetGrid);
    left.append(tabs, this.outlinerPanel, this.assetPanel);

    const center = node('section', 'previs-center');
    this.toolbar = node('div', 'previs-toolbar');
    for (const [mode,label,key] of [['translate','移动','W'],['rotate','旋转','E'],['scale','缩放','R']]) {
      this.toolbar.append(action(`${label} ${key}`, () => api.transform(mode), 'layout-tool-' + mode));
    }
    this.toolbar.append(action('聚焦 F', () => api.focus(), 'layout-focus'));
    this.viewButton = action('自由视角', () => api.toggleView(), 'layout-view-mode');
    this.toolbar.append(this.viewButton, action('当前视角 → 机位', () => api.captureCamera(), 'layout-capture-camera'));
    this.viewport = node('div', 'previs-viewport');
    this.viewport.id = 'layout-viewport';
    this.thirds = node('div', 'previs-thirds');
    this.thirds.id = 'layout-thirds-overlay';
    this.hud = node('div', 'previs-hud');
    this.hud.id = 'layout-camera-hud';
    this.viewport.append(this.thirds, this.hud);
    const viewOptions = node('div', 'previs-view-options');
    for (const [property,label] of [['grid','网格'],['axes','世界轴'],['thirds','三分线']]) {
      const wrap = node('label');
      const input = node('input');
      input.type = 'checkbox';
      input.id = 'layout-view-' + property;
      input.addEventListener('change', () => api.viewport(property, input.checked));
      wrap.append(input, document.createTextNode(label));
      viewOptions.append(wrap);
    }
    this.quality = node('select');
    this.quality.id = 'layout-render-mode';
    this.quality.append(...choices([{id:'simple',label:'简单渲染'},{id:'quality',label:'质量渲染'}], 'quality'));
    this.quality.addEventListener('change', () => api.viewport('renderMode', this.quality.value));
    viewOptions.append(this.quality, node('span','previs-navigation-help','右键 + WASD / QE · 中键平移 · Alt 左键环绕'));
    center.append(this.toolbar, this.viewport, viewOptions);

    this.details = node('aside', 'previs-details');
    this.details.id = 'layout-properties';
    workspace.append(left, center, this.details);
    this.timelineMount = node('section', 'previs-timeline-mount');
    this.timelineMount.id = 'layout-timeline';
    const footer = node('footer', 'previs-footer');
    this.status = node('p');
    this.status.id = 'layout-status';
    this.status.setAttribute('role','status');
    this.status.textContent = '点击对象编辑，直接拖动角色手脚控制点。场景自动保存到本机。';
    const actions = node('div', 'previs-output-actions');
    actions.append(action('取消导出', () => api.cancelExport(), 'layout-cancel-export'), action('视频参考 → H3', () => api.exportVideo(), 'layout-export-video'), action('构图图片 → H3', () => api.exportImage(), 'layout-save', 'previs-button primary'));
    footer.append(this.status, actions);
    this.mount.replaceChildren(header, workspace, this.timelineMount, footer);
    document.getElementById('layout-cancel-export').hidden = true;
    this.setLeftTab('objects');
  }

  setLeftTab(tab) {
    this.outlinerPanel.hidden = tab !== 'objects';
    this.assetPanel.hidden = tab !== 'assets';
    document.getElementById('layout-outliner-tab').classList.toggle('active', tab === 'objects');
    document.getElementById('layout-assets-tab').classList.toggle('active', tab === 'assets');
    if (tab === 'assets') this.renderAssets();
  }

  renderAssets() {
    const query = document.getElementById('layout-asset-search').value.toLowerCase();
    const category = this.assetCategory.value;
    this.assetGrid.replaceChildren();
    this.catalogs.assets.filter(item => (category === 'all' || item.category === category) && (!query || (item.label + ' ' + item.description).toLowerCase().includes(query))).forEach(item => {
      const button = action('', () => this.api.addAsset(item.id), '', 'previs-asset');
      button.dataset.assetType = item.id;
      button.title = item.description || item.label;
      const image = node('img');
      image.alt = '';
      this.api.thumbnail(item.id).then(url => { image.src = url; }).catch(() => {});
      button.append(image, node('span', '', item.label));
      this.assetGrid.append(button);
    });
  }

  renderOutliner(scene, selection) {
    this.outliner.replaceChildren();
    const selected = new Set(selection);
    const children = new Map();
    for (const object of scene.objects) {
      const parent = object.parentId || null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(object);
    }
    const renderBranch = (parentId, depth) => {
      for (const object of children.get(parentId) || []) {
        const row = node('div', 'previs-tree-row');
        row.dataset.objectId = object.id;
        row.style.setProperty('--depth', depth);
        row.classList.toggle('selected', selected.has(object.id));
        row.classList.toggle('muted', object.visible === false);
        row.setAttribute('role','treeitem');
        row.setAttribute('aria-selected', selected.has(object.id));
        row.tabIndex = 0;
        row.draggable = !object.locked;
        const label = node('span', 'previs-tree-label', object.label);
        row.append(icon(object.type === 'group' ? 'group' : 'object'), label);
        row.addEventListener('click', event => {
          if (!event.target.closest('button,input')) this.api.select(object.id, event.ctrlKey || event.metaKey, event.shiftKey);
        });
        row.addEventListener('keydown', event => {
          if (event.key === 'Enter') this.api.select(object.id, event.ctrlKey, event.shiftKey);
          if (event.key === 'F2') label.dispatchEvent(new MouseEvent('dblclick'));
        });
        label.addEventListener('dblclick', () => {
          const input = node('input');
          input.value = object.label;
          label.replaceWith(input);
          input.focus(); input.select();
          let saved = false;
          const finish = () => { if (saved) return; saved = true; this.api.rename(object.id, input.value); };
          input.addEventListener('blur', finish);
          input.addEventListener('keydown', event => { event.stopPropagation(); if(event.key === 'Enter') finish(); if(event.key === 'Escape') { saved=true; this.renderOutliner(scene,selection); } });
        });
        row.append(
          iconAction(object.visible === false ? 'hidden' : 'visible', object.visible === false ? '显示对象' : '隐藏对象', () => this.api.property(object.id,'visible',object.visible === false)),
          iconAction(object.locked ? 'lock' : 'unlock', object.locked ? '解锁对象' : '锁定对象', () => this.api.property(object.id,'locked',!object.locked))
        );
        row.addEventListener('dragstart', event => { event.dataTransfer.setData('application/lumen-objects', JSON.stringify(selected.has(object.id) ? selection : [object.id])); });
        row.addEventListener('dragover', event => { event.preventDefault(); row.classList.add('drop-target'); });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', event => {
          event.preventDefault(); row.classList.remove('drop-target');
          try { this.api.reparent(object.id, JSON.parse(event.dataTransfer.getData('application/lumen-objects'))); } catch {}
        });
        this.outliner.append(row);
        renderBranch(object.id, depth + 1);
      }
    };
    renderBranch(null,0);
    this.parentSelect.replaceChildren(...choices([{id:'',label:'世界（解除挂接）'},...scene.objects.filter(object => !selected.has(object.id)).map(object => ({id:object.id,label:object.label}))], scene.objects.find(object => object.id === selection.at(-1))?.parentId || ''));
    this.parentSelect.disabled = !selection.length;
  }

  section(title, open = true) {
    const section = node('details','previs-section');
    section.open = open;
    section.append(node('summary','',title));
    return section;
  }

  field(targetId, property, label, value, options = {}) {
    const row = node('div','previs-property');
    row.dataset.targetId = targetId;
    row.dataset.property = property;
    const title = node('label','',label);
    const input = node(options.choices ? 'select' : 'input');
    input.id = options.id || `detail-${targetId}-${property.replaceAll('.','-')}`;
    title.htmlFor = input.id;
    if (options.choices) input.append(...choices(options.choices,value));
    else {
      input.type = options.type || (typeof value === 'boolean' ? 'checkbox' : 'number');
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = typeof value === 'number' ? Math.round(value * 1000) / 1000 : value ?? '';
      if (input.type === 'number') { input.step = options.step ?? .01; input.min = options.min ?? -10000; input.max = options.max ?? 10000; }
    }
    input.addEventListener('change', () => {
      if (!input.reportValidity()) return;
      const next = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
      if(options.change) options.change(next); else this.api.property(targetId,property,next);
    });
    const actions = node('div','previs-property-actions');
    if (options.reset !== undefined) actions.append(iconAction('reset','重置这项属性',() => options.change ? options.change(options.reset) : this.api.property(targetId,property,options.reset)));
    if (options.key !== false) {
      const key = action('K',() => this.api.key(targetId, options.keyProperty || property),'','previs-key-button');
      key.title = `为${label}添加关键帧`;
      actions.append(key);
    }
    row.append(title,input,actions);
    return row;
  }

  vector(targetId, property, label, values, defaults, options = {}) {
    const group = node('div','previs-vector');
    const heading=node('div','previs-vector-heading');
    heading.append(node('h4','',label),iconAction('reset','重置'+label,()=>this.api.property(targetId,property,defaults)),action('K',()=>this.api.key(targetId,property),'','previs-key-button'));
    group.append(heading);
    ['X','Y','Z'].forEach((axis,index) => group.append(this.field(targetId,`${property}.${index}`,axis,values[index],options)));
    return group;
  }

  renderDetails(scene, selection, force = false) {
    if (!force && this.details.contains(document.activeElement)) return;
    const savedScroll = this.details.scrollTop;
    const nextObjectId=selection.at(-1)||null;
    const sections=this.detailObjectId===nextObjectId?[...this.details.querySelectorAll('details')].map(section=>[section.querySelector('summary').textContent,section.open]):[];
    this.detailObjectId=nextObjectId;
    this.details.replaceChildren();
    const object = scene.objects.find(item => item.id === selection.at(-1));
    this.details.append(node('h3','previs-detail-title',selection.length > 1 ? `已选 ${selection.length} 个对象` : object?.label || '拍摄相机与环境'));
    if (object) {
      this.details.append(this.field(object.id,'label','名称',object.label,{type:'text',key:false}));
      const transforms = this.section('变换');
      transforms.append(this.vector(object.id,'position','位置 · 米',object.position,[0,0,0]),this.vector(object.id,'rotation','旋转 · 度',object.rotation,[0,0,0],{step:1}),this.vector(object.id,'scale','缩放',object.scale,[1,1,1],{min:.01,max:100}));
      this.details.append(transforms);
      this.details.append(this.field(object.id,'visible','显示',object.visible !== false,{reset:true}),this.field(object.id,'locked','锁定',!!object.locked,{reset:false,key:false}));
      if (object.pose && this.api.isRig(object.id)) this.renderRigDetails(object);
      if (object.type === 'imported' && this.api.clips(object.id).length) {
        const animation=this.section('导入动画');
        animation.append(this.field(object.id,'animation.enabled','播放片段',object.animation?.enabled!==false,{reset:true}),this.field(object.id,'animation.clip','片段',String(object.animation?.clip||0),{choices:this.api.clips(object.id),reset:'0'}),this.field(object.id,'animation.speed','速度',object.animation?.speed??1,{min:0,max:10,reset:1}),this.field(object.id,'animation.offset','偏移 · 秒',object.animation?.offset??0,{min:0,max:300,reset:0}));
        this.details.append(animation);
      }
      if (object.type.endsWith('_light')) {
        const light=this.section('灯光');
        light.append(this.field(object.id,'light.color','颜色',object.light?.color||'#ffffff',{type:'color',reset:'#ffffff'}),this.field(object.id,'light.intensity','强度',object.light?.intensity??3,{min:0,max:1000,reset:3}));
        this.details.append(light);
      }
      if (object.type === 'camera') this.details.append(this.field(object.id,'focal','焦距 · mm',object.focal||35,{min:12,max:300,step:1,reset:35}));
      if (object.type !== 'group' && object.type !== 'camera' && !object.type.endsWith('_light')) {
        const material = this.section('基础材质',false);
        material.append(this.field(object.id,'material.color','颜色',object.material?.color || object.color || '#94aecb',{type:'color',reset:'#94aecb'}));
        for(const [property,label,def,min,max] of [['roughness','粗糙度',.78,0,1],['metalness','金属度',0,0,1],['opacity','不透明度',1,0,1]]) material.append(this.field(object.id,'material.'+property,label,object.material?.[property] ?? def,{min,max,step:.01,reset:def}));
        this.details.append(material);
      }
    }
    const camera = this.section('拍摄机位', !object);
    camera.append(this.field('camera','focal','焦距 · mm',scene.camera.focal,{min:12,max:300,step:1,reset:35,id:'layout-focal'}),this.vector('camera','position','机位 · 米',scene.camera.position,[4.8,2.6,7.5]));
    const angles = this.api.cameraAngles(scene.camera);
    ['俯仰','水平','滚转'].forEach((label,i) => camera.append(this.field('camera','quaternion',label+' · 度',angles[i],{step:1,reset:0,keyProperty:'quaternion',id:'layout-camera-angle-'+i,change:value=>this.api.cameraAngle(i,value)})));
    const rail = this.section('相机轨道',false);
    rail.append(this.field('camera','rail.enabled','启用轨道',!!scene.camera.rail?.enabled,{reset:false}),this.field('camera','rail.progress','轨道进度',scene.camera.rail?.progress || 0,{min:0,max:1,step:.01,reset:0}),this.field('camera','rail.orientation','朝向',scene.camera.rail?.orientation || 'target',{choices:[{id:'target',label:'朝向目标'},{id:'tangent',label:'沿轨道前进'}],reset:'target'}));
    rail.append(this.vector('camera','rail.lookAt','看向目标',scene.camera.rail?.lookAt || [0,1,0],[0,1,0]));
    rail.append(action('用当前视角加轨道点',()=>this.api.railPoint(),'layout-rail-add'));
    const points = node('div','previs-rail-points');
    (scene.camera.rail?.points || []).forEach((point,i) => {
      const line=node('div','previs-rail-row');
      line.append(this.vector('camera',`rail.points.${i}`,`轨道点 ${i+1} · 米`,point,[0,1,0]),action('移除这个点',()=>this.api.removeRailPoint(i),'','previs-small-button'));
      points.append(line);
    });
    rail.append(points);
    camera.append(rail);
    this.details.append(camera);
    const environment=this.section('光照与环境',!object);
    environment.append(this.field('environment','hdri','HDR 环境',scene.environment.hdri || '',{key:false,choices:[{id:'',label:'本地柔光'},...this.catalogs.hdri.map(item=>({id:item.id,label:item.label}))],change:value=>this.api.environment('hdri',value || null)}));
    for(const [key,label,min,max,def] of [['intensity','环境强度',0,5,1],['rotation','环境旋转 · 度',-360,360,0],['exposure','曝光',.1,5,1.35]]) environment.append(this.field('environment',key,label,scene.environment[key],{key:false,min,max,reset:def,change:value=>this.api.environment(key,value)}));
    environment.append(this.field('environment','background','显示 HDR 背景',!!scene.environment.background,{key:false,reset:false,change:value=>this.api.environment('background',value)}));
    this.details.append(environment);
    const clip=this.section('H3 视频参考片段',false);
    clip.append(this.field('export','start','起点 · 秒',this.api.exportRange().start,{key:false,min:0,max:scene.sequence.duration,change:value=>this.api.exportRange({start:value})}),this.field('export','duration','时长 · 秒',this.api.exportRange().duration,{key:false,min:.21,max:15,change:value=>this.api.exportRange({duration:value})}),node('p','previs-help','完整时间线可导出到三维软件。H3 单次视频参考最多 15 秒。'));
    this.details.append(clip);
    for(const [title,open] of sections)for(const section of this.details.querySelectorAll('details'))if(section.querySelector('summary').textContent===title)section.open=open;
    this.details.scrollTop = savedScroll;
  }

  renderRigDetails(object) {
    const rig=this.section('人物姿态');
    const search=node('input');search.type='search';search.placeholder='搜索自然姿态、动作…';search.className='previs-pose-search';
    const poses=node('select');poses.id='layout-pose';
    const fill=()=>poses.replaceChildren(...choices([{id:'',label:'选择姿态…'},...this.catalogs.poses.filter(p=>(p.label+' '+(p.tags||[]).join(' ')+' '+(p.category||'')).toLowerCase().includes(search.value.toLowerCase()))],''));
    fill();search.addEventListener('input',fill);poses.addEventListener('change',()=>{if(poses.value)this.api.pose(object.id,poses.value);});
    rig.append(search,poses,node('p','previs-help','手脚控制点自动显示。直接拖动蓝色点摆姿势，紫色点调整肘膝方向。'));
    for(const [side,label] of [['left','左手手势'],['right','右手手势']]) rig.append(this.field(object.id,'hands.'+side,label,object.hands?.[side] || 'relaxed',{choices:this.catalogs.hands,reset:'relaxed',change:value=>this.api.hand(object.id,side,value)}));
    const fk=this.section('FK 关节与指节',false),joint=node('select');joint.id='layout-joint';
    const remembered=this.api.joint();joint.append(...choices(this.catalogs.joints,remembered));joint.addEventListener('change',()=>{this.api.joint(joint.value);this.renderDetails(this.api.evaluated(),this.api.selection(),true);});
    fk.append(joint,this.vector(object.id,'pose.'+remembered,'关节角度',object.pose?.[remembered] || [0,0,0],[0,0,0],{min:-180,max:180,step:1}));rig.append(fk);
    const body=this.section('人物比例',false);this.catalogs.body.forEach(field=>body.append(this.field(object.id,'body.'+field.id,field.label,object.body?.[field.id] ?? field.default,{...field,id:`detail-${object.id}-body-${field.id}`,reset:field.default})));rig.append(body);
    this.details.append(rig);
    const face=this.section('脸部与表情',false);
    const expressions=node('select');expressions.id='layout-expression';expressions.append(...choices([{id:'',label:'选择表情…'},...this.catalogs.expressions],''));expressions.addEventListener('change',()=>{if(expressions.value)this.api.expression(object.id,expressions.value);});face.append(expressions);
    for(const field of this.catalogs.face) face.append(this.field(object.id,'face.'+field.id,field.label,object.face?.[field.id] ?? field.default,{...field,id:`detail-${object.id}-face-${field.id}`,reset:field.default}));
    this.details.append(face);
  }

  sync(scene, selection, force = false) {
    this.renderOutliner(scene,selection);
    this.renderDetails(scene,selection,force);
    for(const key of ['grid','axes','thirds']) document.getElementById('layout-view-'+key).checked=!!scene.viewport[key];
    this.quality.value=scene.viewport.renderMode;
    this.thirds.hidden=!scene.viewport.thirds;
  }

  message(text,error=false) { this.status.textContent=text;this.status.classList.toggle('error',error); }
  setBusy(busy) {
    document.getElementById('layout-workspace').inert=busy;
    this.timelineMount.inert=busy;
    this.fileActions.inert=busy;
    for(const id of ['layout-save','layout-export-video']) document.getElementById(id).disabled=busy;
    document.getElementById('layout-cancel-export').hidden=!busy;
  }
}
