export const HDR_PRESETS = [
  ['studio_small_09', '柔光摄影棚', 'Sergej Majboroda'],
  ['venice_sunset', '威尼斯落日', 'Greg Zaal'],
  ['kloofendal_48d_partly_cloudy', '山丘多云日光', 'Greg Zaal'],
  ['autumn_field_puresky', '秋日晴空', 'Jarod Guest; Sergej Majboroda'],
].map(([id, label, authors]) => ({
  id, label, authors, url: `/static/hdri/${id}_1k.hdr`,
  preview: `/static/hdri/${id}_preview.jpg`,
  license: 'CC0-1.0', source: `https://polyhaven.com/a/${id}`,
  licenseUrl: 'https://polyhaven.com/license', resolution: '1024 × 512',
}));

export const CHARACTER_REFERENCE_GUIDE = [
  { id: 'original_expressions', label: 'Lumen 原创程序化表情', kind: 'local', description: '可直接使用的参数表情。眼睛、眉毛和嘴通过独立几何构件表达，不依赖外部图像。' },
  { id: 'original_poses', label: 'Lumen 原创姿态', kind: 'local', description: '用于镜头预演的身体重心、动作起止和情绪姿态，可继续编辑 FK 与 IK。' },
  { id: 'posemyart', label: 'PoseMyArt · 外部构图参考', kind: 'link', url: 'https://posemy.art/', description: '仅提供参考网站链接。本软件未下载或打包该站专有姿态、模型或表情图。' },
  { id: 'polyhaven', label: 'Poly Haven · CC0 环境图', kind: 'link', url: 'https://polyhaven.com/hdris', description: '已附四张本地 1K HDR 环境图，来源、作者与校验值见 static/hdri/provenance.json。' },
];
