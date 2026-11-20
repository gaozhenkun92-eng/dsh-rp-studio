# 免责声明 / Disclaimer

本文件适用于 `dsh-rp-studio`（「角色后台」插件，以下简称「本软件」）及其附带的全部代码、配置、预设、提示词、探针脚本与文档。

This file applies to `dsh-rp-studio` (the "Role-play Backstage" plugin, hereinafter "the Software") and every piece of code, configuration, preset, prompt, probe script and document shipped with it.

---

## 1. 按「现状」提供

本软件按 **现状（AS IS）** 与 **现有可用（AS AVAILABLE）** 提供，不附带任何明示或默示的担保，包括但不限于：适销性、特定用途适用性、不侵权、无缺陷、不中断、无错误、数据不丢失、与其他软件兼容。

作者不承诺修复任何缺陷、不承诺任何版本可用、不承诺对任何具体用途有效。你使用本软件的全部风险由你自行承担。

## 2. 使用者的责任

使用本软件即表示你确认并同意：

1. **你有权在自己的设备、自己的账号、自己的数据上做这些事。** 本软件会读写文件、执行命令、访问网络、派生子智能体——这些动作由你开启、由你配置、后果由你承担。
2. **你对本软件产出的全部内容负责**，包括角色卡、世界书、生成文本、生成图片，以及角色借工具实际执行的操作。
3. **你自行确保使用行为符合你所在地的法律法规**，以及你所使用的一切第三方服务的条款：模型服务商、API 中转、图床、GitHub、npm 等。
4. **你自行负责数据备份。** 本软件会把角色卡、世界书、图库写到 `$DSH_HOME/rp-studio/`，也可能（在你开启对应权限后）改到你工作区里的其他文件。删掉的东西可能找不回来。
5. **不把本软件用于**：侵犯他人权益、未经授权访问他人系统或数据、传播违法内容、规避法定审查、诈欺、以及其他任何违法行为。

## 3. 权限与本软件的边界

本软件提供的是「开关」，不是「保证」：

- 权限开关只做运行时工具过滤（`agent.ctx.tools.restrict`），它约束的是工具名字，不约束模型会怎么用这些工具。
- 总开关关闭时，本插件不注入人格段、不改动任何 agent 的工具面；但会话本身的权限由 DSH 宿主与你的会话预设决定，**那部分与本软件无关**。
- 「给予以上之外的其他完整权限」打开后，本软件不再限制任何工具——这是显式选择，不是默认状态。

## 4. 第三方组件与服务

本软件依赖 DeepSeek Harness（DSH）宿主、Node.js、React，以及（可选）第三方模型/出图 API。这些组件的可用性、计费、内容政策、数据处理方式均由各自提供方决定，作者不控制、不担保、不承担连带责任。

本软件与 DeepSeek、SillyTavern、NovelAI 及其他任何第三方**没有隶属、代理、背书或合作关系**；所有商标归各自所有者。

## 5. 责任限制

在适用法律允许的最大范围内，作者不对任何直接、间接、偶然、特殊、惩罚性或后果性损害承担责任，包括但不限于：数据丢失、设备损坏、业务中断、利润损失、账号被封、第三方索赔、法律后果。

即使作者已被告知上述损害可能发生，本条仍然适用。

## 6. 无法律意见

本文件是软件分发时的通用免责声明，**不构成法律意见**。你需要针对自己的实际情况（所在司法辖区、用途、是否商用）自行咨询专业人士。

## 7. 许可

本软件以 MIT 许可发布，许可全文见仓库根目录 `LICENSE`。MIT 许可中的免责条款与本文件并行适用；两者冲突时，以更有利于作者免责的表述为准。

## 8. 变更

作者可随时修改本文件。修改后的版本随新版本发布即生效；继续使用即视为接受。

---

## English (short form)

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

You are solely responsible for: (a) owning or being authorised to use the devices, accounts and data the Software touches; (b) every file operation, shell command, network request and sub-agent action performed by an agent whose tools you enabled; (c) all content produced (cards, worldbooks, text, images); (d) compliance with the laws of your jurisdiction and the terms of every third-party service you connect.

The permission switches restrict tool *names* at runtime; they do not constrain how a model chooses to use those tools. No affiliation with DeepSeek, SillyTavern, NovelAI or any other third party is claimed or implied. This file is not legal advice.
