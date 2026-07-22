# Header Foundry

一个基于 Chrome Manifest V3 和 `declarativeNetRequest` 的请求头/响应头规则管理插件。

## 功能

- 按页面 URL 分组管理规则，同一 URL 只显示一个目标卡片
- 一次批量创建多条动态 Header 规则，已有 URL 自动合并
- 修改请求头或响应头
- 支持 `SET`、`REMOVE` 和受 Chrome 限制的 `APPEND`
- 按页面 URL 和 HTTP Method 匹配，后端请求 URL 不受限制
- 目标整体启停、Header 单条启停、删除和全部清除
- 页面规则支持多选后批量启用、批量停用或反转启用状态
- Popup 默认优先展示规则列表，新增表单和批量管理按需展开
- 已保存的 `SET` / `APPEND` 规则可直接修改 Header 值
- 编辑中的页面 URL 和批量 Header 会自动保存，Popup 关闭后重新打开仍可继续
- 工具栏图标按当前页面是否启用规则切换
- 规则保存在本地，浏览器重启后仍然有效
- 不上传或收集任何规则数据

## 本地安装

1. Chrome 打开 `chrome://extensions`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录 `header-foundry`。
5. 将插件固定到工具栏。

## 快速验证

默认表单预填以下两个请求头：

```http
x-use-ppe: 1
x-tt-env: ppe_xx
```

填写页面 URL 后即可提交，也可以在同一批次继续添加多个 Header。若使用 `httpbin.org` 作为页面规则，创建后访问 <https://httpbin.org/headers>，返回 JSON 中应出现这些请求头。也可以在 Chrome DevTools 的 Network 面板中检查 Request Headers。

## 按页面 URL 管理

- 输入一个页面 URL 后，可通过“添加一行”一次配置多条 Header。
- 点击“使用当前页面”可自动填入当前标签页的域名过滤器，再按需追加路径。
- 页面 URL 只用于匹配浏览器标签页地址，不再匹配后端请求地址。
- 页面地址命中后，该标签页内发出的同源及跨域后端请求都会应用规则。
- 规则按标签页隔离；其他页面即使请求了相同后端地址也不会应用。
- 再次提交相同 URL 时，新 Header 会合并进已有目标卡片。
- 相同“请求/响应位置 + HTTP 方法 + Header 名称”的规则会更新原值，避免产生冲突规则。
- 目标开关控制该 URL 下的全部规则；展开后仍可单独启停或删除某条 Header。
- 从旧版单规则结构升级时，已有数据会自动按 URL 迁移分组。

## 工具栏状态

后台 Service Worker 根据每个标签页的页面 URL 生成带 `tabIds` 条件的 DNR Session Rules，Header 修改和图标状态都按标签页隔离：

- 灰色图标：当前页面 URL 没有启用的规则。
- 荧光绿图标：当前页面 URL 已匹配至少一条启用规则。
- 数字 Badge：当前页面会应用的 Header 规则数，最高显示 `99`。
- 页面 URL 或规则变化时，后台会立即重建对应的标签页规则。

## 项目结构

```text
header-foundry/
├── manifest.json   # 插件声明与权限
├── popup.html      # 弹窗结构
├── popup.css       # 界面样式
├── popup.js        # 规则管理和 DNR 同步
└── README.md
```

## 权限说明

- `declarativeNetRequest`：向 Chrome 网络层注册 Header 修改规则。
- `storage`：在用户本机保存产品层规则数据。
- `webNavigation`：监听页面 URL 与单页应用路由变化，及时切换标签页规则。
- `http://*/*`、`https://*/*`：让用户创建的规则能够作用于对应网站。

面向 Chrome Web Store 发布时，建议根据产品定位评估是否改成 `optional_host_permissions`，在用户创建规则时再申请具体站点访问权。
