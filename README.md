# Crisp Ripple

Obsidian 新开一个标签页、还没打开任何笔记时，中间只有四个按钮，其余是一大片空白。Crisp Ripple 在这片空白里铺一层很淡的字符，缓慢漂移；鼠标划过，字符被推开再弹回；点一下，从点击处泛起一圈波纹，伴随一声水滴落水的声音。

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.0%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)
[![Crisp Suite](https://img.shields.io/badge/Crisp-Suite-orange.svg)](https://github.com/letschips)

## 功能

- **字符背景**：空标签页铺一层低对比度的字符，随噪声场缓慢漂移，不遮挡「新建笔记」等按钮。
- **指针推开**：鼠标经过时，附近的字符被推开、亮起，离开后弹回原位。
- **点击波纹**：从点击位置向外扩散，颜色默认跟随主题的蓝色，约 2 秒后消失；波纹经过时把字符向外推开。
- **水滴音效**：用 Web Audio 实时合成，不带音频文件；声音按点击位置左右偏移，每次音高略有不同。可以关闭、调音量、试听。
- **外观调节**：形态（字符 / 圆点）、波纹颜色（主题蓝色 / 主题强调色 / 自定义）、波纹速度、波纹浓淡、背景浓淡（可设为 0 隐藏背景）、推开力度（可设为 0 关闭位移）。
- 只在空标签页出现，打开笔记后自动移除；停用插件后不留任何元素。
- 系统开启「减少动态效果」时，只显示静止的字符背景，字符不会被推开。

命令面板里有一条 `Toggle water-drop sound`，可以快速开关音效。

## 激活

未激活时，字符背景、指针推开和默认蓝色波纹可以直接使用；水滴音效和外观调节需要激活码。

- 支持 Crisp Suite 全家桶授权码或单款授权码，在设置页「软件授权与激活」里输入。
- 库里已经激活过其他 Crisp 插件时，Crisp Ripple 启动后会自动继承授权；Ripple 自己保存的授权到期或失效时，也会改用库里仍然有效的授权。
- 授权码先在本地用内置的 Ed25519 公钥验签。激活时和每次启动后，会在后台向 `https://license.letschips.xyz/api/verify-device` 核对一次吊销状态与设备数；网络不可用、超时（2.5 秒）或服务暂不可用时，降级为本地验签，不影响使用。
- 除上述授权核对外，插件不发出任何网络请求，不收集使用数据。

## 安装

### 通过 BRAT 安装

1. 安装并启用 Obsidian42 - BRAT 插件。
2. 命令面板执行 `BRAT: Add a beta plugin for testing`。
3. 输入 `letschips/crisp-ripple`，添加后在「第三方插件」里启用 Crisp Ripple。

### 手动安装

1. 从 [Releases](https://github.com/letschips/crisp-ripple/releases) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放进库目录下的 `.obsidian/plugins/crisp-ripple/`。
3. 重启 Obsidian 或在设置里重新加载插件，然后启用 Crisp Ripple。

仅支持桌面端。

## 授权与许可

Crisp Ripple 是专有商业软件，版权归作者 letschips 所有。详细条款见 [LICENSE](LICENSE)。

- 作者主页：小红书 [@letschips](https://xhslink.cn/m/3MwtKu4822b)
- 公众号：来吃薯条儿
