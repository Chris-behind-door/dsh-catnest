// dsh-catnest 客户端半（存在感 UI，里程碑四 v4：实时流 + 客厅主体化）。
// 手写 ModuleLoader 产物格式（与 dsh-client-ui-* 构建产物同构，免构建链）：
//   window.__ModuleLoader__.load({ id, factory(require) { ...exports.apply/inject } })
//
// 形态（主人拍板）：侧栏一级入口「🏠 进入猫窝」（sidebar.footer.action）→
// shell.overlay 全屏家工作区（不透明奶油底整页覆盖，原生 UI 压在底下，零接管
// 零风险）——左窄导航列（小地图+回顾）/ 中栏【对话流占主体】+ 大输入框 /
// 右侧全员状态卡。顶栏时间片开关 + 返回工作台。温馨手绘亮色风。
//
// v4 变化（立竿见影三连）：
//   1. 实时流：EventSource 订阅 /catnest/api/events（快照=state+dialogue、reaction），
//      取代 5s/4s 双轮询；断流自动降级 20s 低频轮询兜底，恢复即停。
//      接话是后台链：主人消息 POST 立刻上屏（乐观插入），角色台词陆续从流里冒出。
//   2. 多角色接话由宿主串行链完成（后者看得到前者的话），前端无需关心人数。
//   3. 对话区占主体（flex 2.2 vs 左 190px / 右 230px）；输入框 textarea 自适应
//      加高（Enter 发送 / Shift+Enter 换行）；消息与地图标记接入姐姐的像素头像
//      （/catnest/api/avatar/<id>.png，image-rendering: pixelated 保住像素质感）。
//
// 关键实现约束（踩过的坑）：
//   - repo bundle 的 client 模块环境【没有】 styles 等 builtin（那是动态插件才
//     有的注入）→ 样式用 injectStyles() 手写 <style> DOM 注入（幂等）。
//   - React #60：dangerouslySetInnerHTML 与 children 互斥 → SVG 注入层与
//     热区/角色标记层必须是兄弟节点。
//   - 进入猫窝联动开片：HomeWorkspace mount 时发现未开片则自动 POST open。
//   - 地图角色上图：fetch plan.svg 文本剥掉静态示例组后 innerHTML 注入，
//     HTML 层按 viewBox 百分比叠加真实角色标记与房间热区。

window.__ModuleLoader__.load({
	id: 'dsh-catnest',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react = require('react');
		const h = react.createElement;

		// ── 户型图几何（与 assets/homeplan.svg 一致，viewBox 1140×720）──
		// 大地图 §2（2026-09-20）：右边那一栏是小区「月见庭」的户外节点，与屋里同属一张图
		// （后端 home.rooms 里带 outdoor:true）。屋里几何一个字没动，画布只往右加宽到 1140。
		// 玄关 ↔ 单元门口 那条是全图唯一的门边：跨它才算出门 / 回家。
		const VB_W = 1140;
		const VB_H = 720;
		// 两张图各自的实用范围（含 SVG 里那圈留白）。小地图按「此刻在哪一栏」只切一块出来——
		// 166px 宽的框里塞 1140 宽的两栏，字会糊到看不清（主人 2026-09-20 指出的问题）。
		// 两块取景窗：都取 736×688（各自把屋子 / 小区居中装进去）。
		// 为什么死磕「两块比例完全相同」：SVG 带了 width="1140" 属性 + 内联 height:auto，
		// 元素实际会按 1140:720 的比例撑高；只要取景窗比例跟它不一样，内容就会留白，
		// 而 HTML 那层标记是按盒子尺寸算百分比的 → 整体偏移。所以这里是硬约束，别随手改：
		//   家里 16..744 × 16..704（纸上那圈留白），小区 752..1124 × 16..704。
		// 两块都是 736:688，缩放比一致 → 格子一样大，也没有留白。
		const AREA_BOX = {
			home: { x: 16, y: 16, w: 736, h: 688, label: '家里' },
			yard: { x: 752, y: 16, w: 736, h: 688, label: '月见庭 · 小区' },
		};
		const ROOM_GEO = {
			entry: { name: '玄关', rect: [250, 40, 140, 130] },
			living: { name: '客厅', rect: [250, 170, 260, 220] },
			kitchen: { name: '厨房', rect: [40, 170, 210, 220] },
			balcony: { name: '阳台', rect: [510, 170, 210, 220] },
			study: { name: '书房', rect: [450, 390, 130, 140] },
			bedroom: { name: '卧室', rect: [250, 390, 200, 140] },
			bath: { name: '浴室', rect: [250, 530, 200, 130] },
			// ── 小区（月见庭）：与 assets/homeplan.svg 里的矩形一一对应 ──
			unit_door: { name: '单元门口', rect: [790, 124, 240, 92], outdoor: true },
			path: { name: '步道', rect: [800, 252, 200, 88], outdoor: true },
			garden: { name: '小花园', rect: [753, 372, 94, 100], outdoor: true },
			bench: { name: '长椅', rect: [1060, 372, 60, 100], outdoor: true },
			store: { name: '便利店', rect: [800, 472, 60, 100], outdoor: true },
			gate: { name: '小区大门', rect: [1060, 472, 60, 100], outdoor: true },
		};
		// 把 svg 的 viewBox 换成只含某一块（小地图用）：只改取景范围，不动比例。
		// 两块都按 760×720 归一（`cnx-mini-inner` 也锁这个比例），所以「家」和「小区」
		// 用的是同一把尺子——切范围时格子大小不变。
		// ⚠️ 别在这里补比例：补了就不是 760×720 了，屋那块会被塞进 1140 宽，反而变小
		// （2026-09-20 实测踩到，实测脚本 ~/ 里那份 viewBox 校验就是这么抓出来的）。
		const svgViewBoxOf = (svgText, area) => {
			if (!svgText) return null;
			// area 为 null/未给 = **全图**（放大版要屋内+屋外都看得见）。
			// ⚠️ 这里曾经写成 `AREA_BOX[area] || AREA_BOX.home`，结果放大版被当成「家里」
			// 切成了 736×688 的小取景框 —— 图上就出现「客厅被放大、月见庭跑出框外」，
			// 而且热区与房间错位（沙盒实测横偏 5.9%、纵偏全乱）。别再把默认值写成 home。
			const b = area ? AREA_BOX[area] : { x: 0, y: 0, w: VB_W, h: VB_H };
			const out = svgText.replace(
				/viewBox="[^"]*"/,
				'viewBox="' + b.x + ' ' + b.y + ' ' + b.w + ' ' + b.h + '"',
			);
			return { text: out, box: { x: b.x, y: b.y, w: b.w, h: b.h } };
		};
		// 给注入的 <svg> 钉上宽高**属性**（属性优先级最高，不受样式表 !important 影响）。
		// 放大版专用：容器已按同一组像素值定死，两边必然对齐。
		const pinSvgSize = (svgText, w, h) => {
			if (!svgText) return svgText;
			return svgText.replace(/<svg([^>]*)>/, (m, attrs) => {
				const a = attrs.replace(/\s(?:width|height)="[^"]*"/g, '');
				return '<svg' + a + ' width="' + w + '" height="' + h + '">';
			});
		};

		// 此刻该看哪一栏：主人在哪就算哪（出去散步时当然看小区）；主人出远门就看猫在哪。
		const areaOf = (data) => {
			const m = (data && data.master) || {};
			const inYard = (room) => !!(ROOM_GEO[room] || {}).outdoor;
			if (m.room && inYard(m.room)) return 'yard';
			if (m.place && m.place.kind === 'home') return 'home';
			if (m.room) return 'home';
			const chars = (data && data.characters) || [];
			if (chars.some((c) => c && inYard(c.room))) return 'yard';
			return 'home';
		};
		const roomCenter = (id) => {
			const g = ROOM_GEO[id];
			if (!g) return null;
			return [g.rect[0] + g.rect[2] / 2, g.rect[1] + g.rect[3] / 2];
		};

		// ── 像素头像 ──
		const AVATAR_IDS = ['kyu', 'moli', 'master'];
		const avatarSrc = (who) =>
			AVATAR_IDS.indexOf(who) >= 0 ? '/catnest/api/avatar/' + who + '.png' : null;

		// ── 数据面 ──
		async function fetchState() {
			const res = await fetch('/catnest/api/state');
			if (!res.ok) throw new Error('state ' + res.status);
			return res.json();
		}
		async function act(payload) {
			const res = await fetch('/catnest/api/action', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const value = await res.json();
			if (!res.ok) throw new Error(value && value.error ? value.error : 'action ' + res.status);
			return value;
		}
		async function fetchPlanSvg() {
			const res = await fetch('/catnest/api/plan.svg');
			if (!res.ok) throw new Error('plan ' + res.status);
			const text = await res.text();
			// 剥掉静态示例组：真实角色由 HTML 层按数据渲染（两组内均无嵌套 g）
			return text
				.replace(/<g id="inhabitants"[\s\S]*?<\/g>/, '')
				.replace(/<g id="legend"[\s\S]*?<\/g>/, '');
		}

		// 实时事件流：SSE 主通道 + 断流降级轮询兜底。
		// onEvent(evt)：{kind:'snapshot', state, dialogue} | {kind:'reaction',...} | {kind:'replyError',...}
		// onState(status)：'connecting' | 'live' | 'down'（断流降级中）——连接状态必须可见。
		function connectEvents(onEvent, onState) {
			let es = null;
			let fallback = null;
			let disposed = false;
			if (onState) onState('connecting');
			const startFallback = () => {
				if (fallback || disposed) return;
				fallback = setInterval(async () => {
					try {
						const [s, d] = await Promise.all([
							fetchState(),
							fetch('/catnest/api/dialogue').then((r) => r.json()),
						]);
						onEvent({ kind: 'snapshot', state: s, dialogue: d });
					} catch {
						if (onState) onState('down');
					}
				}, 20000);
			};
			const stopFallback = () => {
				if (fallback) {
					clearInterval(fallback);
					fallback = null;
				}
			};
			try {
				es = new EventSource('/catnest/api/events');
				es.onopen = () => {
					stopFallback();
					if (onState) onState('live');
				};
				es.onmessage = (ev) => {
					stopFallback();
					if (onState) onState('live');
					try {
						onEvent(JSON.parse(ev.data));
					} catch {
						/* 坏帧忽略 */
					}
				};
				es.onerror = () => {
					startFallback();
					if (onState) onState('down'); // EventSource 自带重连，重连成功会再触发 onopen
				};
			} catch {
				startFallback();
				if (onState) onState('down');
			}
			return () => {
				disposed = true;
				stopFallback();
				if (es) es.close();
			};
		}

		// ── 样式（温馨手绘亮色风；DOM 注入，repo bundle 无 styles builtin）──
		// 幂等是「同 id 只留一个元素」，但**内容要跟着模块换**：旧版看到 id 存在就直接
		// return，于是 HMR 换过模块之后是「新 JSX + 旧样式表」，主人 2026-09-16 实测到的
		// 三条通栏音量按钮（旧规则 flex-direction:column）就是这么来的。现在发现内容不一致
		// 就原地更新，样式随模块一起热更。
		const STYLE_ID = 'dshcatnest-css';
		function injectStyles() {
			if (typeof document === 'undefined') return;
			const el = document.getElementById(STYLE_ID);
			if (el) {
				if (el.textContent !== CSS) el.textContent = CSS;
				return;
			}
			const created = document.createElement('style');
			created.id = STYLE_ID;
			created.textContent = CSS;
			document.head.appendChild(created);
		}
		const CSS = [
			':root{--cnx-bg:#fff9f0;--cnx-card:#fffdf7;--cnx-ink:#5b4a3f;--cnx-sub:#a08c7d;',
			'--cnx-accent:#e8a87c;--cnx-accent-deep:#d98f5f;--cnx-line:#ead9c6;--cnx-green:#8fbf9f;}',
			// 一级入口（侧栏）与全屏工作区
			'.cnx-entry{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;',
			'color:inherit;font:inherit;font-weight:600;padding:9px 12px;border-radius:10px;cursor:pointer;text-align:left;}',
			'.cnx-entry:hover{background:var(--cnx-bg);}',
			'.cnx-full{position:fixed;inset:0;z-index:100;background:var(--cnx-bg);color:var(--cnx-ink);',
			'display:flex;flex-direction:column;gap:12px;padding:18px;overflow:auto;box-sizing:border-box;',
			'font-size:13px;line-height:1.55;}',
			'.cnx-card{background:var(--cnx-card);border:2px solid var(--cnx-line);',
			'border-radius:255px 15px 225px 15px / 15px 225px 15px 255px;padding:12px 14px;}',
			'.cnx-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
			'.cnx-title{font-weight:700;font-size:16px;display:flex;align-items:center;gap:8px;margin-right:auto;}',
			'.cnx-badge{font-size:12px;color:var(--cnx-sub);border:1.5px dashed var(--cnx-line);',
			'border-radius:999px;padding:2px 10px;background:var(--cnx-card);}',
			'.cnx-badge.on{color:#5f8f6e;border-color:var(--cnx-green);}',
			'.cnx-btn{border:2px solid var(--cnx-line);background:var(--cnx-card);color:var(--cnx-ink);',
			'font:inherit;font-size:12px;padding:4px 12px;border-radius:12px;cursor:pointer;}',
			'.cnx-btn:hover{border-color:var(--cnx-accent);color:var(--cnx-accent-deep);}',
			'.cnx-btn.primary{background:var(--cnx-accent);border-color:var(--cnx-accent-deep);color:#fff;}',
			'.cnx-btn[disabled]{opacity:.5;cursor:default;}',
			'.cnx-note{font-size:12px;color:#8a6d3b;background:#fdf3dd;border:1.5px dashed #ecd9a8;',
			'border-radius:10px;padding:6px 12px;}',
			'.cnx-err{font-size:12px;color:#c0564f;background:#fdeceb;border:1.5px dashed #f2c4c0;',
			'border-radius:10px;padding:6px 12px;}',
			// 三栏：对话列占主体（flex:2.2），左右窄列伺候它
			'.cnx-body{display:flex;gap:14px;align-items:stretch;min-height:0;flex:1;width:100%;}',
			'.cnx-navcol{flex:0 0 190px;max-width:190px;overflow:hidden;display:flex;flex-direction:column;gap:10px;min-height:0;}',
			'.cnx-dialogcol{flex:2.2;min-width:0;display:flex;flex-direction:column;min-height:0;}',
			'.cnx-side{flex:0 0 230px;display:flex;flex-direction:column;gap:10px;min-height:0;overflow-y:auto;}',
			// 对话流（客厅主体）
			'.cnx-msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:4px 6px;min-height:0;}',
			'.cnx-msgrow{display:flex;gap:9px;align-items:flex-start;max-width:92%;}',
			'.cnx-msgrow.master{align-self:flex-end;flex-direction:row-reverse;}',
			'.cnx-avatar{width:34px;height:34px;border-radius:50%;border:2px solid var(--cnx-line);',
			'background:var(--cnx-card);flex:0 0 auto;image-rendering:pixelated;object-fit:cover;',
			'box-shadow:0 1px 3px rgba(120,90,50,.25);margin-top:14px;}',
			'.cnx-msgcol{display:flex;flex-direction:column;gap:2px;min-width:0;}',
			'.cnx-msg{padding:7px 13px;border-radius:16px;background:var(--cnx-card);',
			'border:1.5px solid var(--cnx-line);font-size:15px;line-height:1.6;word-break:break-word;',
			'white-space:pre-wrap;}',
			// 台词伴随的即时动作（舞台指示）：气泡内前缀，弱化为小字斜体
			'.cnx-action{font-size:11px;color:var(--cnx-sub);font-style:italic;margin-right:3px;}',
			// 音量→字号（§9.16）：字体映射和传播范围是两个独立的东西，这里只管显示。
			// 2026-09-16 主人反馈「现在这个已经挺小的了」→ 只往上加、不往下缩：
			// 正常 15px；小声**不缩小**（跟正常同一个档位附近，靠淡+斜体+收窄留白表达耳语），
			// 大声 17.5px 加粗。三档的差别要一眼看得出，但不能以看不清为代价。
			'.cnx-msg.v-low{font-size:14px;opacity:.78;font-style:italic;letter-spacing:.01em;}',
			'.cnx-msg.v-high{font-size:17.5px;font-weight:600;letter-spacing:.01em;}',
			'.cnx-msg-who{font-size:11px;color:var(--cnx-sub);padding:0 4px;}',
			// 名字后面缀音量小标（小声/大声）：光靠字号变化不够明确，给它一个说得出口的名字
			'.cnx-voltag{color:var(--cnx-accent-deep);opacity:.85;}',
			'.cnx-msg.kyu{border-color:var(--cnx-green);}',
			'.cnx-msg.moli{border-color:#b05060;background:#fdf0f3;}',
			'.cnx-msg.master{border-color:var(--cnx-accent);background:#fdf3e7;}',
			'.cnx-msgrow.master .cnx-msg-who{text-align:right;}',
			'.cnx-msgs-empty{color:var(--cnx-sub);font-size:12px;text-align:center;padding:18px 0;}',
			// 输入区（2026-09-16 三次修订，按主人要的样子）：
			//   一张卡＝输入框本身（主模式的结构）：文本域在上，工具行贴右下；
			//   音量＝**上拉菜单**（一个按钮显示当前档，点开往上弹三档）；说键＝**框内右下角**。
			//   两个控件同一行、同一个高度（26px），不再有阶梯，也不再有通栏的包裹感。
			'.cnx-inputbox{position:relative;display:flex;flex-direction:column;gap:4px;margin-top:10px;',
			'border:2px solid var(--cnx-line);border-radius:16px;padding:8px 10px 7px 12px;',
			'background:var(--cnx-card);transition:border-color .15s;}',
			'.cnx-inputbox:focus-within{border-color:var(--cnx-accent);}',
			'.cnx-input{border:none;background:transparent;padding:2px 2px 0;',
			'font:inherit;font-size:14px;line-height:1.55;color:inherit;',
			'outline:none;resize:none;min-height:34px;max-height:150px;box-sizing:border-box;}',
			'.cnx-inputfoot{display:flex;align-items:center;gap:8px;}',
			'.cnx-inputfoot .cnx-btn{height:26px;padding:0 16px;font-size:12.5px;border-radius:999px;flex:none;}',
			// 音量上拉菜单：按钮显示当前档，菜单往上弹（不会盖住对话流）
			'.cnx-volwrap{position:relative;}',
			'.cnx-volbtn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;',
			'border:1.5px solid var(--cnx-line);border-radius:999px;background:transparent;color:var(--cnx-sub);',
			'font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s;}',
			'.cnx-volbtn:hover{border-color:var(--cnx-accent);color:var(--cnx-accent-deep);}',
			'.cnx-volbtn.active{color:var(--cnx-accent-deep);border-color:var(--cnx-accent);background:#fdf3dd;font-weight:600;}',
			'.cnx-caret{font-size:9px;opacity:.7;}',
			'.cnx-volmenu{position:absolute;bottom:calc(100% + 6px);left:0;z-index:30;min-width:196px;',
			'background:var(--cnx-card);border:1.5px solid var(--cnx-line);border-radius:12px;',
			'box-shadow:0 8px 20px rgba(120,90,50,.18);padding:5px;}',
			'.cnx-volitem{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;',
			'color:inherit;font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;cursor:pointer;text-align:left;}',
			'.cnx-volitem:hover{background:var(--cnx-bg);}',
			'.cnx-volitem.cur{color:var(--cnx-accent-deep);font-weight:600;}',
			'.cnx-volhint{padding:2px 8px 5px;color:var(--cnx-sub);font-size:10.5px;line-height:1.4;}',
			'.cnx-sendhint{font-size:10px;color:var(--cnx-sub);text-align:right;margin-top:3px;padding-right:2px;}',
			// 连接状态徽标 / 接话等待条 / 失败提示（一切异常可见，不静默）
			'.cnx-stream{margin-left:auto;font-size:10px;color:var(--cnx-sub);border:1px dashed var(--cnx-line);',
			'border-radius:999px;padding:1px 8px;white-space:nowrap;}',
			'.cnx-stream.live{color:#5f8f6e;border-color:var(--cnx-green);}',
			'.cnx-stream.down{color:#c0564f;border-color:#f2c4c0;background:#fdeceb;}',
			'.cnx-waiting{font-size:12px;color:#8a6d3b;background:#fdf3dd;border:1.5px dashed #ecd9a8;',
			'border-radius:10px;padding:5px 12px;margin-top:6px;}',
			'.cnx-sysnote{font-size:12px;color:#c0564f;background:#fdeceb;border:1.5px dashed #f2c4c0;',
			'border-radius:10px;padding:5px 12px;margin-top:6px;}',
			// 打字机气泡（delta 流式输出中）
			'.cnx-drafting{opacity:.85;}',
			// 没能说出口的台词（§9.2 修订/2026-09-15）：留在原地别凭空消失。
			// 但别再半透明了——主人 2026-09-16 说「这弄个半透明也太难看了」；现在改成
			// 虚线框 + 浅底，字仍然是清晰的，只是明确标出它没进账本（§9.17 兜底之后，
			// 这种情况本身已经少见了）。
			'.cnx-unsaid .cnx-drafting{background:#fbf6ee;border-style:dashed;border-color:#e2cbb0;}',
			'.cnx-unsaid .cnx-msg-who{color:#b98b5e;}',
			'.cnx-cursor{display:inline-block;margin-left:1px;animation:cnxBlink 1s steps(2) infinite;color:var(--cnx-accent-deep);}',
			'@keyframes cnxBlink{0%,49%{opacity:1}50%,100%{opacity:0}}',
			// 换模型入口（手绘徽章 + 卡片菜单，与猫窝视觉同路）
			'.cnx-modelpick{position:relative;display:inline-block;}',
			'.cnx-modelbtn{display:inline-flex;align-items:center;gap:6px;max-width:220px;',
			'border:1.5px dashed var(--cnx-line);background:var(--cnx-card);color:var(--cnx-sub);',
			'font:inherit;font-size:12px;padding:3px 12px;border-radius:999px;cursor:pointer;',
			'transition:border-color .15s,color .15s;}',
			'.cnx-modelbtn:hover{border-color:var(--cnx-accent);color:var(--cnx-accent-deep);}',
			'.cnx-modelbtn .cnx-mname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
			'.cnx-modelmenu{position:absolute;top:calc(100% + 8px);right:0;z-index:130;width:300px;',
			'max-height:62vh;overflow-y:auto;background:var(--cnx-card);color:var(--cnx-ink);',
			'border:2px solid var(--cnx-line);padding:12px;transform-origin:top right;',
			'animation:cnxMenuIn .14s ease-out;box-sizing:border-box;',
			'box-shadow:0 10px 34px rgba(90,60,30,.22);}',
			'@keyframes cnxMenuIn{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}',
			'.cnx-mtitle{font-size:11px;color:var(--cnx-sub);margin-bottom:6px;display:flex;align-items:center;gap:5px;}',
			'.cnx-mgroup{font-size:12px;font-weight:600;color:var(--cnx-ink);display:flex;align-items:center;gap:6px;',
			'width:100%;text-align:left;border:0;background:transparent;padding:6px 8px;border-radius:10px;cursor:pointer;}',
			'.cnx-mgroup:hover{background:var(--cnx-bg);}',
			'.cnx-mgroup.active{color:var(--cnx-accent-deep);}',
			'.cnx-mdot{width:7px;height:7px;border-radius:50%;background:var(--cnx-line);flex:0 0 auto;}',
			'.cnx-mgroup.active .cnx-mdot{background:var(--cnx-accent);}',
			'.cnx-msub{margin:2px 0 4px 15px;border-left:2px dashed var(--cnx-line);padding-left:6px;}',
			'.cnx-mitem{display:flex;align-items:center;gap:7px;width:100%;text-align:left;border:0;',
			'background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 8px;',
			'border-radius:9px;cursor:pointer;transition:background .12s;}',
			'.cnx-mitem:hover{background:#fdf0e4;}',
			'.cnx-mitem.active{color:#5f8f6e;background:#f0f6ee;}',
			'.cnx-mitem[disabled]{opacity:.55;cursor:default;}',
			'.cnx-mitem .cnx-mid{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
			'.cnx-mcheck{color:var(--cnx-green);font-weight:700;flex:0 0 auto;}',
			'.cnx-mdim{color:var(--cnx-sub);font-size:12px;padding:5px 8px;}',
			// 地图与标记
			'.cnx-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;}',
			'.cnx-minimap{cursor:zoom-in;position:relative;}',
			'.cnx-minimap:hover{border-color:var(--cnx-accent);}',
			'.cnx-minimap .cnx-mark-name,.cnx-minimap .cnx-mark-act{display:none;}',
			'.cnx-zoomhint{position:absolute;right:8px;bottom:6px;font-size:11px;color:var(--cnx-sub);',
			'background:rgba(255,253,247,.92);border:1px solid var(--cnx-line);border-radius:999px;padding:1px 8px;}',
			'.cnx-lightbox{position:fixed;inset:0;z-index:120;background:rgba(91,74,63,.45);',
			'display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}',
			// 放大版卡片：原来卡在 900px，1920 屏上图纸只占半屏（主人 2026-09-20 反馈「大地图太小」）
			'.cnx-lightbox-card{width:min(1700px,96vw);max-height:92vh;overflow:auto;background:var(--cnx-card);',
			'border:2px solid var(--cnx-line);border-radius:18px;padding:14px;box-shadow:0 18px 60px rgba(90,60,30,.35);}',
			'.cnx-mapcard{padding:10px;}',
			'.cnx-mapwrap{position:relative;border-radius:14px;overflow:hidden;border:2px solid var(--cnx-line);',
			'max-height:none;}',
			// ── 放大版（大地图）──
			// 尺寸**不靠 CSS 推**：由 useFitBox() 量出可用空间后写成像素值（见那段注释）。
			// 这里只留一条 CSS 兜底（万一 ResizeObserver 没跑，也不至于溢出得太离谱）。
			// ⚠️ 五条实测教训（2026-09-20 反复踩，别再绕回去）：
			//   ① `width:max-content` 让容器贴合 SVG：max-content 依赖 SVG 固有尺寸，固有尺寸
			//      又回头看容器宽 —— 成环，浏览器给出错宽度。
			//   ② 让 SVG 按高度反算宽度（`height:calc();width:auto`）：数值能对，但只要容器或
			//      卡片上限小一点，右边就被裁（实测图 1814 宽 vs 卡片 1700）。
			//   ③ 给 SVG 加会压扁它的 max-height：压扁 = 内容比例变了 = 标记立刻偏。
			//   ④ 卡片上限要跟着放大（原来 900px）。
			//   ⑤ **改 CSS 必须整页刷新**：injectStyles() 只在 apply() 时注入一次，client 插件
			//      热更新只换组件代码、不重跑 apply —— 主人浏览器里可能还是旧样式。
			//      所以放大版尺寸别依赖某条新 CSS 生效，交给 JS 量（这一条是真被坑过）。
			// ⚠️ 两条实测教训，别再犯：
			//   ① calc 里**不能除以无单位数**：`calc((92vh - 96px) * 1140 / 720)` 会被整条丢弃
			//      （线上实测 max-width = none，图就肆意溢出）。乘法请用常数因子。
			//   ② 因子**别写反**：图纸是 1140 宽 720 高，所以「宽上限 = 可用高度 × 1140/720」
			//      = × 1.5833；写成 0.6316（那是高/宽）会让图缩到只有应有尺寸的 40%
			//      ——2026-09-20 实测：窗口高 757 时只给 363px 宽，图上缩成一小块。
			// zoombox 给**明确高度**（不能只给 max-height）：不然它 clientHeight=0，
			// JS 量不到可用空间，就只能退回 CSS（实测窄窗口下会从底部溢出）。
			'.cnx-zoombox{overflow:auto;height:calc(92vh - 96px);}',
			// 放大版的尺寸只由这一条决定：图钉在「可用高度」上，宽高比写死 1140:720。
			// 容器（zoomfit / mapwrap）不设宽度 —— 它们是块级元素，宽度会自动贴合里面的图，
			// 于是「容器宽 == 图宽」，HTML 那层标记的百分比必然对得上（这是折腾一整天的那件事）。
			// ⚠️ 千万别给这条链上的容器写 width:100% / max-width：一旦容器宽 != 图宽，
			//    标记就会横向或纵向偏（实测偏过 18.6%）。
			'.cnx-zoomfit{box-sizing:border-box;}',
			// 边框改 box-shadow：`.cnx-mapwrap` 原本有 2px 边框，而绝对定位的标记/热区
			// 是按**边框盒内边**（padding box）算百分比的、SVG 的 viewport 也等于 padding box，
			// 但标记的 left/top 百分比却按边框盒算 —— 差 2px，实测横向偏 5.9%。
			// 换成不占布局的 box-shadow，两边就完全同一个坐标系了。
			'.cnx-zoomfit .cnx-mapwrap{border:none;border-radius:12px;box-shadow:0 0 0 2px var(--cnx-line);}',
			'.cnx-zoomfit .cnx-mapwrap svg{width:100%;height:100%;}',
			// 图纸尺寸全靠 viewBox 的固有比例：根元素里没有 width/height 属性，
			// 所以 height:auto = width × (viewBox 高/宽)，跟内容严丝合缝（别再往 svg 里加
			// width/height 属性，那会把固有比例换掉，HTML 那层标记立刻偏）。
			'.cnx-mapwrap svg,.cnx-svglayer svg{display:block;width:100%;height:auto;}',
			// 小地图内层：只负责圆角，**不锁比例、也不给 max-height**。
			// ⚠️ 2026-09-20 实测教训（两次都栽在同一个原理上）：HTML 那层标记是绝对定位铺满
			// `.cnx-mapwrap` 的，百分比按**盒子**算；而 SVG 是按内容撑高的。所以只要有任何
			// 东西把盒子压矮/压扁（锁 aspect-ratio、给 max-height 都会），标记立刻整体偏移。
			// 实测：锁 760:720 → 盒子 166×104.8（内容 155.2），热区偏 3.8%；给 max-height:46vh
			// 在小窗口下更狠，偏 25%。结论：这块**别加约束**，让 SVG 撑高、盒子跟着它。
			'.cnx-mini-inner{overflow:hidden;border-radius:12px;}',
			'.cnx-mini-inner .cnx-mapwrap{border:0;border-radius:12px;}',
			'.cnx-ui{position:absolute;inset:0;z-index:2;}',
			'.cnx-zone{position:absolute;cursor:pointer;}',
			'.cnx-zone:hover{background:rgba(232,168,124,.14);box-shadow:inset 0 0 0 2.5px var(--cnx-accent);border-radius:10px;}',
			'.cnx-mark{position:absolute;transform:translate(-50%,-100%);pointer-events:none;',
			'display:flex;flex-direction:column;align-items:center;gap:1px;z-index:3;}',
			'.cnx-face{width:26px;height:26px;border-radius:50%;border:2px solid var(--cnx-green);',
			'background:#fffdf7;box-shadow:0 1px 4px rgba(120,90,50,.35);',
			'image-rendering:pixelated;object-fit:cover;}',
			'.cnx-face.moli{border-color:#b05060;}',
			'.cnx-face.master{border-color:var(--cnx-accent-deep);border-radius:7px;}',
			'.cnx-face.fallback{display:flex;align-items:center;justify-content:center;',
			'font-size:12px;color:var(--cnx-ink);}',
			'.cnx-mark-name{font-size:11px;color:var(--cnx-ink);background:rgba(255,253,247,.92);',
			'border:1px solid var(--cnx-line);border-radius:999px;padding:0 7px;white-space:nowrap;}',
			'.cnx-mark-act{font-size:10px;color:var(--cnx-accent-deep);white-space:nowrap;}',
			'.cnx-char{display:flex;flex-direction:column;gap:4px;}',
			'.cnx-char-top{display:flex;align-items:center;gap:8px;}',
			'.cnx-char-face{width:30px;height:30px;border-radius:50%;border:2px solid var(--cnx-line);',
			'image-rendering:pixelated;object-fit:cover;}',
			'.cnx-char-name{font-weight:600;}',
			'.cnx-char-room{font-size:12px;color:var(--cnx-sub);}',
			'.cnx-char-act{margin-left:auto;font-size:12px;color:var(--cnx-accent-deep);}',
			'.cnx-char-act.paused{opacity:.6;}',
			'.cnx-cond{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;}',
			'.cnx-cond-badge{font-size:11px;border-radius:999px;padding:1px 8px;white-space:nowrap;',
			'border:1px solid var(--cnx-line);color:var(--cnx-ink);}',
			'.cnx-cond-badge.active{border-color:var(--cnx-accent);color:var(--cnx-accent-deep);',
			'background:#fdf3dd;}',
			'.cnx-cond-badge.pending{border-style:dashed;color:var(--cnx-sub);}',
			'.cnx-cond-badge.expired{opacity:.45;text-decoration:line-through;}',
			'.cnx-cycle{display:flex;justify-content:space-between;gap:8px;font-size:11px;margin-top:3px;',
			'color:var(--cnx-sub);}',
			'.cnx-cycle .on{color:var(--cnx-accent-deep);}',
			'.cnx-cycle .after{opacity:.75;}',
			'.cnx-rel{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--cnx-sub);}',
			'.cnx-bar{flex:1;height:7px;background:var(--cnx-bg);border:1px solid var(--cnx-line);border-radius:99px;overflow:hidden;}',
			'.cnx-fill{height:100%;background:linear-gradient(90deg,#f2c096,var(--cnx-accent));}',
			'.cnx-call{margin-left:auto;border:1.5px solid var(--cnx-line);background:transparent;color:inherit;',
			'font-size:11px;padding:2px 10px;border-radius:999px;cursor:pointer;}',
			'.cnx-char-top .cnx-call{margin-left:auto;}',
			'.cnx-call:hover{color:var(--cnx-accent-deep);border-color:var(--cnx-accent);}',
			'.cnx-say{font-size:12px;color:var(--cnx-ink);background:#fdf3dd;border-left:3px solid var(--cnx-accent);',
			'border-radius:0 10px 10px 0;padding:5px 10px;}',
			'.cnx-recap{font-size:12px;color:var(--cnx-sub);}',
			// HOUSE_DESIGN §1/§2 家当（右侧栏，角色卡下面）：一房间一行，房间名左列、物品淡色
			// 右列，行间一条极淡的分隔线；✎ 悬停才现身，点开就在该行下方展开编辑。
			'.cnx-things{font-size:11.5px;line-height:1.5;color:var(--cnx-sub);}',
			'.cnx-things-title{font-size:12.5px;color:var(--cnx-ink);font-weight:600;margin-bottom:2px;',
			'display:flex;align-items:center;gap:6px;}',
			'.cnx-things-hint{margin-left:auto;font-weight:400;font-size:10.5px;color:var(--cnx-sub);}',
			'.cnx-t3-row{display:flex;gap:7px;align-items:baseline;padding:3.5px 0;}',
			'.cnx-t3-row + .cnx-t3-row{border-top:1px solid rgba(234,217,198,.6);}',
			'.cnx-t3-name{flex:0 0 40px;color:var(--cnx-accent-deep);font-weight:600;position:relative;',
			'padding-left:9px;}',
			'.cnx-t3-name::before{content:"";position:absolute;left:0;top:5.5px;width:4px;height:4px;',
			'border-radius:50%;background:var(--cnx-line);}',
			'.cnx-t3-row.here .cnx-t3-name::before{background:var(--cnx-green);',
			'box-shadow:0 0 4px var(--cnx-green);}',
			'.cnx-t3-items{flex:1 1 auto;min-width:0;color:var(--cnx-ink);word-break:break-word;}',
			'.cnx-t3-items .st{color:var(--cnx-sub);}',
			'.cnx-t3-items .n{color:var(--cnx-accent-deep);font-weight:600;}',
			'.cnx-room-edit{border:none;background:none;color:var(--cnx-sub);cursor:pointer;font-size:11px;',
			'padding:0 2px;line-height:1;flex:0 0 auto;opacity:0;transition:opacity .15s;}',
			'.cnx-t3-row:hover .cnx-room-edit,.cnx-room-edit:focus{opacity:1;}',
			'.cnx-room-edit:hover{color:var(--cnx-accent-deep);}',
			// 编辑态（HOUSE_DESIGN §2）：不挤在窄栏里，点 ✎ 弹一张手绘编辑卡——三列对齐
			// （名字 / 数量 / 状态）+ 右下角正式按钮，编辑这件事本身看着像家里的一部分。
			'.cnx-editmask{position:fixed;inset:0;background:rgba(91,74,63,.34);z-index:130;',
			'display:flex;align-items:center;justify-content:center;padding:20px;}',
			'.cnx-editbox{width:min(430px,100%);max-height:80vh;overflow-y:auto;background:var(--cnx-card);',
			'border:2px solid var(--cnx-line);border-radius:22px 8px 20px 8px / 8px 20px 8px 22px;',
			'padding:16px 18px;box-shadow:0 12px 32px rgba(120,90,50,.22);}',
			'.cnx-editbox-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
			'.cnx-editbox-title{font-weight:700;font-size:14px;color:var(--cnx-ink);}',
			'.cnx-editbox-x{margin-left:auto;border:none;background:none;color:var(--cnx-sub);cursor:pointer;',
			'font-size:15px;line-height:1;padding:2px 7px;border-radius:9px;}',
			'.cnx-editbox-x:hover{color:var(--cnx-accent-deep);background:#fdf3dd;}',
			'.cnx-editgrid{display:grid;grid-template-columns:1fr 52px 1fr 26px;gap:7px 8px;align-items:center;}',
			'.cnx-eg-head{font-size:10.5px;color:var(--cnx-sub);padding-left:3px;}',
			'.cnx-eg-in{border:1.5px solid var(--cnx-line);border-radius:10px;background:#fff;color:var(--cnx-ink);',
			'font:inherit;font-size:12px;padding:5px 9px;min-width:0;width:100%;box-sizing:border-box;}',
			'.cnx-eg-in::placeholder{color:#c9b6a6;}',
			'.cnx-eg-in:focus{outline:none;border-color:var(--cnx-accent);',
			'box-shadow:0 0 0 3px rgba(232,168,124,.16);}',
			'.cnx-eg-num{text-align:center;padding-left:4px;padding-right:4px;}',
			'.cnx-eg-del{border:none;background:none;color:var(--cnx-sub);cursor:pointer;font-size:13px;',
			'line-height:1;padding:3px;border-radius:8px;}',
			'.cnx-eg-del:hover{color:#c0564f;background:#fdeceb;}',
			'.cnx-editbox-empty{font-size:12px;color:var(--cnx-sub);padding:12px 2px;}',
			'.cnx-editbox-foot{display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;',
			'border-top:1px dashed var(--cnx-line);}',
			'.cnx-eg-gap{flex:1 1 auto;}',
			// 按钮一律走暖色系（不出现灰白描边按钮，那是后台管理的样子，出戏）
			'.cnx-eadd{border:1.5px dashed var(--cnx-accent);background:rgba(232,168,124,.09);',
			'color:var(--cnx-accent-deep);font:inherit;font-size:12px;padding:5px 14px;border-radius:11px;',
			'cursor:pointer;}',
			'.cnx-eadd:hover{background:rgba(232,168,124,.2);}',
			'.cnx-ebtn{border:none;background:none;color:var(--cnx-sub);font:inherit;font-size:12.5px;',
			'padding:6px 15px;border-radius:12px;cursor:pointer;}',
			'.cnx-ebtn:hover{color:var(--cnx-accent-deep);background:rgba(232,168,124,.14);}',
			'.cnx-ebtn.save{background:var(--cnx-accent);color:#fff;font-weight:600;',
			'box-shadow:0 2px 6px rgba(217,143,95,.35);}',
			'.cnx-ebtn.save:hover{background:var(--cnx-accent-deep);color:#fff;}',
			'.cnx-ebtn[disabled]{opacity:.55;cursor:default;}',
			'.cnx-things .cnx-err{margin-top:6px;font-size:11px;}',
			// 入口：🏠 图标本体常驻，时间片状态做成屋角发光小圆点（off 也清晰可辨）
			'.cnx-entry-icon{position:relative;display:inline-flex;font-size:17px;line-height:1;flex:0 0 auto;}',
			'.cnx-entry-lamp{position:absolute;top:-3px;right:-5px;width:8px;height:8px;border-radius:50%;',
			'background:var(--cnx-sub);border:1.5px solid var(--cnx-card);}',
			'.cnx-entry-lamp.on{background:var(--cnx-green);box-shadow:0 0 6px var(--cnx-green);}',
		].join('');

		// ── 小工具 ──
		const pct = (v, total) => (v / total) * 100 + '%';

		// 放大版尺寸：量出可用空间后**算出像素尺寸**贴在图上。
		// ⚠️ 用**回调 ref** 触发测量，别用 useEffect：放大版是条件渲染的（zoom 为 true 才挂），
		//    挂载那一刻 `.cnx-zoombox` 还不存在、ref 是 null，而 useEffect 只在 ratio 变化时
		//    重跑 —— 结果就是 fit() 一次都没执行（2026-09-20 沙盒实测：effect 里 hasBox=false，
		//    之后再没进来过）。回调 ref 在节点真正挂上/更换时触发，天然对。
		function useFitBox(ratio) {
			const boxRef = react.useRef(null); // 可用空间（外层滚动盒）
			const mapRef = react.useRef(null); // 实际贴尺寸的定位盒（lightbox 关着时为 null，占位用）
			const [size, setSize] = react.useState(null);
			// 用 ref 存一份状态，回调 ref 里不用闭包捕获旧值
			const stateRef = react.useRef({ ratio, timer: null, size: null });
			stateRef.current.ratio = ratio;
			const apply = () => {
				const st = stateRef.current;
				const box = boxRef.current;
				if (!box) return;
				const availW = box.clientWidth || 0;
				const availH = box.clientHeight || 0;
				if (availW < 4 || availH < 4) return;
				let w = availW;
				let h = w / st.ratio;
				if (h > availH) {
					h = availH;
					w = h * st.ratio;
				}
				w = Math.round(w);
				h = Math.round(h);
				if (st.size && st.size.w === w && st.size.h === h) return; // 幂等，防抖
				st.size = { w, h };
				setSize({ w, h });
			};
			const schedule = () => {
				const st = stateRef.current;
				if (st.timer) return;
				st.timer = setTimeout(() => {
					st.timer = null;
					apply();
				}, 0);
				if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
			};
			react.useEffect(() => {
				if (typeof ResizeObserver !== 'function') return;
				let ro = null;
				if (boxRef.current) {
					ro = new ResizeObserver(schedule);
					ro.observe(boxRef.current);
				}
				if (typeof window !== 'undefined') window.addEventListener('resize', schedule);
				return () => {
					if (ro) ro.disconnect();
					if (typeof window !== 'undefined') window.removeEventListener('resize', schedule);
				};
			});
			// 回调 ref：节点挂上/更换时都会调，第一次就把尺寸量出来
			const setBox = (node) => {
				boxRef.current = node;
				schedule();
			};
			const setMap = (node) => {
				mapRef.current = node;
			};
			return { setBox, setMap, size };
		}

		function Face(props) {
			// 像素头像：有图用图，无图回退首字符圆块
			const { who, name, cls } = props;
			const src = avatarSrc(who);
			if (src) return h('img', { className: cls, src, alt: name || who, draggable: false });
			return h(
				'span',
				{ className: cls + ' fallback' },
				(name || who || '?').slice(0, 1),
			);
		}

		function MapPanel(props) {
			const { data, svgText, onMove, wrapClass, area, fixedSize } = props;
			const chars = (data && data.characters) || [];
			// 大地图 §3：主人可能在家、也可能在小区（place.kind !== 'away' 就是可寻址的）；
			// atHome 只是派生值，落位要用 room。
			const masterRoom =
				data && data.master && data.master.room && data.master.place && data.master.place.kind !== 'away'
					? data.master.room
					: null;
			// 大地图 §4：小地图只显示「此刻所在的那一栏」（不传 area = 全图，放大版用）。
			// 切法是把 svg 的 viewBox 换掉——HTML 标记层与热区随之按同一块框算百分比。
			const vb = svgViewBoxOf(svgText, area || null);
			const box = vb ? vb.box : { x: 0, y: 0, w: VB_W, h: VB_H };
			// 标记落位：同房间多个体横向错开；主人可寻址时也落位（橘边方块脸）
			const byRoom = {};
			chars.forEach((c) => {
				if (c && c.room) (byRoom[c.room] = byRoom[c.room] || []).push(c);
			});
			if (masterRoom) {
				(byRoom[masterRoom] = byRoom[masterRoom] || []).push({
					id: '__master',
					name: '主人',
					master: true,
					walking: (data.master && data.master.walking) || [],
				});
			}
			const marks = [];
			Object.keys(byRoom).forEach((roomId) => {
				const c0 = roomCenter(roomId);
				if (!c0) return;
				const group = byRoom[roomId];
				group.forEach((c, i) => {
					const dx = (i - (group.length - 1) / 2) * 40;
					marks.push({ c, x: c0[0] + dx, y: c0[1] + 26 });
				});
			});
			// 热区与标记：换算到切好的那一块框里（框外的不渲染，省得画出界）
			const inBox = (r) =>
				r[0] + r[2] > box.x && r[0] < box.x + box.w && r[1] + r[3] > box.y && r[1] < box.y + box.h;
			const dot = (v, o, size) => ((v - o) / size) * 100 + '%';
			return h(
				'div',
				{ className: wrapClass === null ? 'cnx-mapcard-plain' : wrapClass || 'cnx-card cnx-mapcard' },
				h(
					'div',
					{
						className: 'cnx-mapwrap',
						// 放大版：把量出来的像素宽高贴上去。容器与图同宽同高 ⇒ 标记百分比必然对齐。
						// （这个 div 不是 SVG，全局那条 svg{width:100%!important} 管不着它；
						//  SVG 那边靠 width/height 属性钉死，见下面 svglayer 处。）
					style: fixedSize ? { width: fixedSize.w + 'px', height: fixedSize.h + 'px' } : null,
					},
					// SVG 注入层：dangerouslySetInnerHTML 与 children 互斥（React #60），
					// 热区/标记放兄弟交互层
					vb
						? h('div', {
								className: 'cnx-svglayer',
								// 放大版：把量出的宽高写进 <svg> 的 width/height **属性**。
								// 属性优先级高于样式表里的 svg{width:100%!important}，而内联 style
								// 打不过 !important —— 2026-09-20 沙盒实测：只靠 CSS 时 950x604 的图
								// 被算成 888 高，纵向偏 29%。
								dangerouslySetInnerHTML: {
									__html: fixedSize ? pinSvgSize(vb.text, fixedSize.w, fixedSize.h) : vb.text,
								},
							})
						: h(
								'div',
								{ style: { padding: '48px', textAlign: 'center', color: 'var(--cnx-sub)' } },
								'地图加载中……',
							),
					vb
						? h(
								'div',
								{ className: 'cnx-ui' },
								Object.keys(ROOM_GEO)
									.filter((id) => inBox(ROOM_GEO[id].rect))
									.map((id) => {
										const r = ROOM_GEO[id].rect;
										return h('div', {
											key: id,
											className: 'cnx-zone',
											title: '把主人移到' + ROOM_GEO[id].name,
											style: {
												left: dot(r[0], box.x, box.w),
												top: dot(r[1], box.y, box.h),
												width: (r[2] / box.w) * 100 + '%',
												height: (r[3] / box.h) * 100 + '%',
											},
											onClick: () => onMove(id),
										});
									}),
								marks
									.filter((m) => m.x > box.x && m.x < box.x + box.w && m.y > box.y && m.y < box.y + box.h)
									.map((m) =>
										h(
											'div',
											{
												key: m.c.id,
												className: 'cnx-mark',
												style: { left: dot(m.x, box.x, box.w), top: dot(m.y, box.y, box.h) },
											},
											h(Face, {
												who: m.c.id === '__master' ? 'master' : m.c.id,
												name: m.c.name,
												cls: 'cnx-face' + (m.c.master ? ' master' : m.c.id === 'moli' ? ' moli' : ''),
											}),
											h('span', { className: 'cnx-mark-name' }, m.c.name),
											// 大地图 §6：牵着手的画一个 🤝（小声说话也听得见的那条特例）
											Array.isArray(m.c.walking) && m.c.walking.length > 0
												? h('span', { className: 'cnx-mark-act', title: '牵着手' }, '🤝')
												: null,
											m.c.activity
												? h('span', { className: 'cnx-mark-act' }, m.c.activity)
												: null,
										),
									),
							)
						: null,
				),
			);
		}

		// 家里有什么（HOUSE_DESIGN §1 家当）：主人视角看全屋，挂在右侧栏角色卡下面。
		// 一房间一行：房间名左列（小点标记，有人的点亮起）+ 物品淡色右列，行间极淡分隔线；
		// ✎ 悬停才现身。
		// §2 编辑：点 ✎ 弹一张手绘编辑卡（三列对齐：名字 / 数量 / 状态 + 正式按钮），
		// 不把表单塞进 230px 的窄栏里；保存走 op setItems 整表替换，后端校验从严，
		// 报错原样显示在卡里，账本不动。
		function ThingsCard(props) {
			const { data } = props;
			const rooms = (data && data.rooms) || [];
			const [editing, setEditing] = react.useState(null);
			const [draft, setDraft] = react.useState([]);
			const [err, setErr] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const here = {};
			((data && data.characters) || []).forEach((c) => {
				if (c && c.room) here[c.room] = true;
			});
			if (data && data.master && data.master.room && data.master.place && data.master.place.kind !== 'away') {
				here[data.master.room] = true;
			}
			// 大地图 §2：小区节点也在这张表里（outdoor），但它们没有家当——
			// 「家里有什么」只列屋里那七间；小区那一栏走地图，不占这张卡的篇幅。
			const indoor = rooms.filter((r) => !r.outdoor);
			if (rooms.length === 0) return null;
			const editingRoom = editing ? rooms.find((r) => r.id === editing) || null : null;
			const begin = (r) => {
				setEditing(r.id);
				setErr(null);
				setDraft(
					(r.items || []).map((it) => ({
						name: it.name,
						count: (it.count || 1) > 1 ? String(it.count) : '',
						state: it.state || '',
					})),
				);
			};
			const cancel = () => {
				setEditing(null);
				setDraft([]);
				setErr(null);
			};
			const upd = (i, key, value) =>
				setDraft((prev) => prev.map((d, j) => (j === i ? { ...d, [key]: value } : d)));
			const drop = (i) => setDraft((prev) => prev.filter((_, j) => j !== i));
			const addOne = () => setDraft((prev) => [...prev, { name: '', count: '', state: '' }]);
			const save = async () => {
				setSaving(true);
				setErr(null);
				try {
					await act({
						op: 'setItems',
						room: editing,
						items: draft.map((d) => ({ name: d.name, count: d.count, state: d.state })),
					});
					setEditing(null);
					setDraft([]);
				} catch (e) {
					setErr(String(e && e.message ? e.message : e));
				} finally {
					setSaving(false);
				}
			};
			// 物品行：名字（墨色）· 名字 ×N（数量）· （状态）——数量与状态压成淡色，别抢眼
			const itemsLine = (items) => {
				if (!items || items.length === 0) {
					return [h('span', { key: 'empty', className: 'st' }, '还没有东西')];
				}
				const out = [];
				items.forEach((it, i) => {
					if (i > 0) out.push(h('span', { key: 'sep' + i, className: 'st' }, ' · '));
					out.push(h('span', { key: 'n' + i }, it.name));
					if ((it.count || 1) > 1) {
						out.push(h('span', { key: 'c' + i, className: 'n' }, ' ×' + it.count));
					}
					if (it.state) out.push(h('span', { key: 's' + i, className: 'st' }, '（' + it.state + '）'));
				});
				return out;
			};
			const modal = editingRoom
				? h(
						'div',
						{
							className: 'cnx-editmask',
							onClick: (e) => {
								if (e.target === e.currentTarget) cancel();
							},
						},
						h(
							'div',
							{ className: 'cnx-editbox' },
							h(
								'div',
								{ className: 'cnx-editbox-head' },
								h('span', { className: 'cnx-editbox-title' }, '🧺 ' + editingRoom.name + ' 的东西'),
								h('button', { className: 'cnx-editbox-x', title: '关闭', onClick: cancel }, '✕'),
							),
							draft.length > 0
								? h(
										'div',
										{ className: 'cnx-editgrid' },
										h('span', { className: 'cnx-eg-head' }, '名字'),
										h('span', { className: 'cnx-eg-head' }, '数量'),
										h('span', { className: 'cnx-eg-head' }, '状态（可留空）'),
										h('span', { key: 'pad' }, null),
										draft.map((d, i) => [
											h('input', {
												key: 'n' + i,
												className: 'cnx-eg-in',
												value: d.name,
												placeholder: '比如 消婴器',
												onChange: (e) => upd(i, 'name', e.target.value),
											}),
											h('input', {
												key: 'c' + i,
												className: 'cnx-eg-in cnx-eg-num',
												value: d.count,
												placeholder: '1',
												onChange: (e) => upd(i, 'count', e.target.value),
											}),
											h('input', {
												key: 's' + i,
												className: 'cnx-eg-in',
												value: d.state,
												placeholder: '空的 / 关着',
												onChange: (e) => upd(i, 'state', e.target.value),
											}),
											h(
												'button',
												{
													key: 'd' + i,
													className: 'cnx-eg-del',
													title: '删掉这件',
													onClick: () => drop(i),
												},
												'✕',
											),
										]),
									)
								: h('div', { className: 'cnx-editbox-empty' }, '这个房间还空着，点下面加一件吧'),
							err ? h('div', { className: 'cnx-err' }, '⚠ ' + err) : null,
							h(
								'div',
								{ className: 'cnx-editbox-foot' },
								h('button', { className: 'cnx-eadd', disabled: saving, onClick: addOne }, '＋ 加一件'),
								h('span', { className: 'cnx-eg-gap' }),
								h('button', { className: 'cnx-ebtn', disabled: saving, onClick: cancel }, '取消'),
								h(
									'button',
									{ className: 'cnx-ebtn save', disabled: saving, onClick: save },
									saving ? '保存中…' : '保存',
								),
							),
						),
					)
				: null;
			return h(
				react.Fragment,
				null,
				h(
					'div',
					{ className: 'cnx-card cnx-things' },
					h(
						'div',
						{ className: 'cnx-things-title' },
						'🧺 家里有什么',
						h('span', { className: 'cnx-things-hint' }, '悬停 ✎ 可增减'),
					),
					indoor.map((r) =>
						h(
							'div',
							{ key: r.id, className: 'cnx-t3-row' + (here[r.id] ? ' here' : '') },
							h('span', { className: 'cnx-t3-name' }, r.name),
							h('span', { className: 'cnx-t3-items' }, itemsLine(r.items || [])),
							h(
								'button',
								{ className: 'cnx-room-edit', title: '改这个房间的东西', onClick: () => begin(r) },
								'✎',
							),
						),
					),
				),
				modal,
			);
		}

		// 持久状态徽章：active 显示剩余时间、pending 显示开始倒计时（前端本地 60s tick，
		// 不依赖 SSE 推送——倒计时是时间驱动的，快照变动不会勤到分钟级）。
		function condRemain(fromMs, toMs) {
			const ms = Math.max(0, (toMs || 0) - (fromMs || 0));
			const d = Math.floor(ms / 86400000);
			const h = Math.floor((ms % 86400000) / 3600000);
			const m = Math.floor((ms % 3600000) / 60000);
			if (d > 0) return d + '天' + (h > 0 ? h + '小时' : '');
			if (h > 0) return h + '小时' + m + '分';
			return Math.max(1, m) + '分钟';
		}
		// 持久状态徽章：由 startAt/endAt 与本地时钟实时推导相位（pending→active→expired
		// 前端全自动，不依赖后端快照频率），active 显「还剩X」、pending 显「还有X开始」；
		// 60s tick 重算倒计时文本。
		function condPhaseLocal(cond) {
			const now = Date.now();
			const s = cond.startAt ? new Date(cond.startAt).getTime() : 0;
			const e = cond.endAt ? new Date(cond.endAt).getTime() : 0;
			if (s && now < s) return 'pending';
			if (e && now >= e) return 'expired';
			return 'active';
		}
		function CondBadge(props) {
			const cond = props.cond || {};
			const [, setTick] = react.useState(0);
			react.useEffect(() => {
				const t = setInterval(() => setTick((n) => n + 1), 60000);
				return () => clearInterval(t);
			}, []);
			const now = Date.now();
			const phase = condPhaseLocal(cond);
			let suffix = '';
			if (phase === 'active' && cond.endAt) suffix = '（还剩' + condRemain(now, new Date(cond.endAt).getTime()) + '）';
			else if (phase === 'pending' && cond.startAt) suffix = '（还有' + condRemain(now, new Date(cond.startAt).getTime()) + '开始）';
			else if (phase === 'expired') suffix = '（已结束）';
			// 来路（§9.18）：她自己挂的 / 家里给的（周期或每日期），鼠标停上去能看到出处
			const src = cond.source === 'system' ? '家里给的' : '自己挂的';
			return h(
				'span',
				{
					className: 'cnx-cond-badge ' + (phase === 'pending' ? 'pending' : phase === 'expired' ? 'expired' : 'active'),
					title: src + (cond.note ? '：' + cond.note : ''),
				},
				cond.label + suffix,
			);
		}

		// 发情周期条（§9.18，2026-09-17 主人拍板）：常驻的日历——本轮/下一次是确定日期
		// （抖动已经落盘），「再下次」是虚线预计。她自己的上下文只在前 2 天才有倒计时，
		// 这条是给主人看的：不用猜下一次是哪天。本地 60s 重算，不依赖快照频率。
		function fmtDay(ms) {
			const d = new Date(ms);
			return d.getMonth() + 1 + '月' + d.getDate() + '日';
		}
		function CycleLine(props) {
			const cy = props.cy;
			const [, setTick] = react.useState(0);
			react.useEffect(() => {
				const t = setInterval(() => setTick((n) => n + 1), 60000);
				return () => clearInterval(t);
			}, []);
			if (!cy || !cy.startAt) return null;
			const now = Date.now();
			const start = new Date(cy.startAt).getTime();
			const end = cy.endAt ? new Date(cy.endAt).getTime() : 0;
			const head =
				cy.phase === 'active'
					? '发情中（还剩' + condRemain(now, end) + '）'
					: '发情 ' + fmtDay(start) + '（还有' + condRemain(now, start) + '）';
			const after = cy.afterStart ? fmtDay(new Date(cy.afterStart).getTime()) : '';
			return h(
				'div',
				{ className: 'cnx-cycle', title: '周期 ' + cy.gapDays + ' 天 · 每次 ' + cy.durDays + ' 天' },
				h('span', { className: cy.phase === 'active' ? 'on' : '' }, head),
				after ? h('span', { className: 'after' }, '再下次 ' + after + ' 预计') : null,
			);
		}

		// 活动行（§9.14 主人 2026-09-14 定案）：activity 必带结束时间，所以跟 condition 一样
		// 显示剩余时间；暂停态（放下锅铲）单独标出来。本地 60s tick 重算，不依赖快照频率。
		function ActLine(props) {
			const c = props.c || {};
			const [, setTick] = react.useState(0);
			react.useEffect(() => {
				const t = setInterval(() => setTick((n) => n + 1), 60000);
				return () => clearInterval(t);
			}, []);
			if (!c.activity) return null;
			let suffix = '';
			if (c.activityPaused) suffix = '（放下了，可以接回）';
			else if (c.activityEndsAt) {
				const now = Date.now();
				const end = new Date(c.activityEndsAt).getTime();
				suffix = end > now ? '（还剩' + condRemain(now, end) + '）' : '（快做完了）';
			}
			return h(
				'div',
				{ className: 'cnx-char-act' + (c.activityPaused ? ' paused' : '') },
				c.activity + suffix,
			);
		}

		function CharCard(props) {
			const { c, relations, busy, onCall, say } = props;
			const pair = relations['master:' + c.id];
			// 发情从徽章里剔掉：它由下面的周期条承担，免得同一件事显示两遍（§9.18）
			const conds = (Array.isArray(c.conditions) ? c.conditions : []).filter(
				(x) => x && x.name !== '发情' && x.name !== '发情期' && x.label !== '发情期',
			);
			return h(
				'div',
				{ className: 'cnx-card cnx-char' },
				h(
					'div',
					{ className: 'cnx-char-top' },
					h(Face, { who: c.id, name: c.name, cls: 'cnx-char-face' }),
					h('span', { className: 'cnx-char-name' }, c.name),
					h(
						'span',
						{ className: 'cnx-char-room' },
						// 大地图 §4：小区里的地方加「小区·」前缀，跟屋里分得开（屋里用老口径 @房间）
						(c.outdoor ? '小区·' : '@') + ((ROOM_GEO[c.room] || {}).name || c.room),
					),
					Array.isArray(c.walking) && c.walking.length > 0 ? h('span', { title: '牵着手' }, '🤝') : null,
					h(
						'button',
						{ className: 'cnx-call', disabled: !!busy, onClick: () => onCall(c.id) },
						'喊一下',
					),
				),
				h(ActLine, { c }),
				conds.length > 0
					? h(
							'div',
							{ className: 'cnx-cond' },
							conds.map((x) => h(CondBadge, { key: x.id || x.name, cond: x })),
						)
					: null,
				h(CycleLine, { cy: c.cycle }),
				pair
					? h(
							'div',
							{ className: 'cnx-rel' },
							h('span', null, '亲密'),
							h(
								'div',
								{ className: 'cnx-bar' },
								h('div', { className: 'cnx-fill', style: { width: pair.intimacy + '%' } }),
							),
							h('span', null, pair.intimacy),
							h('span', { style: { marginLeft: '6px' } }, '色色'),
							h(
								'div',
								{ className: 'cnx-bar' },
								h('div', {
									className: 'cnx-fill',
									style: { width: pair.spice + '%', background: '#e79aab' },
								}),
							),
							h('span', null, pair.spice),
						)
					: null,
				say ? h('div', { className: 'cnx-say' }, say) : null,
			);
		}

		// ── 模式开关：「进入猫窝」= 全屏家工作区（Entry 与 Panel 共享）──
		const store = { listeners: new Set(), mode: false };
		const setMode = (v) => {
			store.mode = v;
			store.listeners.forEach((f) => f());
		};
		const subscribe = (f) => {
			store.listeners.add(f);
			return () => store.listeners.delete(f);
		};

		// 侧栏一级入口：🏠 进入猫窝（绿灯 = 时间片进行中；30s 轻轮询即可）
		function Entry(props) {
			const wide = !!(props && props.wide);
			const [on, setOn] = react.useState(false);
			react.useEffect(() => {
				let alive = true;
				const tick = () =>
					fetchState()
						.then((s) => {
							if (alive) setOn(!!(s && s.status && s.status.open));
						})
						.catch(() => {});
				tick();
				const t = setInterval(tick, 30000);
				return () => {
					alive = false;
					clearInterval(t);
				};
			}, []);
			return h(
				'button',
				{ className: 'cnx-entry', title: '进入猫窝', onClick: () => setMode(true) },
				h(
					'span',
					{ className: 'cnx-entry-icon' },
					'🏠',
					h('span', { className: 'cnx-entry-lamp' + (on ? ' on' : '') }),
				),
				wide ? h('span', null, '进入猫窝') : null,
			);
		}

		// 全屏工作区挂载面（shell.overlay）：mode 开时整页覆盖
		function Panel() {
			const [open, setOpen] = react.useState(store.mode);
			react.useEffect(() => subscribe(() => setOpen(store.mode)), []);
			return open ? h(HomeWorkspace) : null;
		}

		// 家里的话：中栏对话流（占主体的客厅）。lines/says 由 HomeWorkspace 经 SSE 统一供血；
		// 气泡 white-space:pre-wrap 支持多行台词；输入框 textarea 多行自适应加高（Enter 发送 / Shift+Enter 换行），
		// 加高或新内容时若原本贴底则保持贴底，上翻回看时不打扰；发送后乐观上屏。
		// stream/waiting/sysNotes：连接状态、接话等待、失败提示——一切异常都要可见。
		function DialoguePanel(props) {
			const { lines, says, onSend, stream, waiting, sysNotes, drafting } = props;
			const [draft, setDraft] = react.useState('');
			const [sending, setSending] = react.useState(false);
			const boxRef = react.useRef(null);
			const taRef = react.useRef(null);
			// 主人说话的音量（§9.16）：小声=耳语（隔壁听不见），大声=喊（隔壁听得清、当场被叫醒）。
			// 面板上是一个上拉菜单（按钮显示当前档），选中的档一直留着，读完私房话自己切回正常。
			const [volume, setVolume] = react.useState('正常');
			const [volOpen, setVolOpen] = react.useState(false);
			const volRef = react.useRef(null);
			react.useEffect(() => {
				if (!volOpen) return undefined;
				const onDocDown = (e) => {
					if (volRef.current && !volRef.current.contains(e.target)) setVolOpen(false);
				};
				const onKey = (e) => {
					if (e.key === 'Escape') setVolOpen(false);
				};
				document.addEventListener('mousedown', onDocDown);
				document.addEventListener('keydown', onKey);
				return () => {
					document.removeEventListener('mousedown', onDocDown);
					document.removeEventListener('keydown', onKey);
				};
			}, [volOpen]);
			// 贴底判定：用 ref 记录"用户是否还在底部附近"（上次已知状态）。
			// 内容增高/输入框加高都不触发 scroll 事件，只有用户自己滚动才更新它，
			// 所以"原本贴底 → 变化后继续贴底；上翻回看 → 不被新内容拽回底部"。
			const atBottomRef = react.useRef(true);
			const onBoxScroll = () => {
				const el = boxRef.current;
				if (!el) return;
				atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
			};
			react.useEffect(() => {
				const el = boxRef.current;
				if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
			}, [lines, drafting && drafting.buf, waiting]);
			const autoGrow = () => {
				const ta = taRef.current;
				if (!ta) return;
				const cur = ta.style.height;
				ta.style.height = 'auto';
				// 自然高（46px）与 .cnx-input 的 min-height 对齐
				const next = Math.min(Math.max(ta.scrollHeight, 34), 150) + 'px';
				// 必须总是写回具体高度：'auto' 下 textarea 回落成 rows:1 的自然高，
				// 多行草稿会被 min-height 截断（高度没变时赋值是布局 no-op，不必省）
				ta.style.height = next;
				if (next !== cur) {
					// 输入框增高会挤小对话区：原本贴底的话，增高后依然保持贴底
					const el = boxRef.current;
					if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
				}
			};
			const send = async () => {
				const text = draft.trim();
				if (!text || sending) return;
				setSending(true);
				setDraft('');
				if (taRef.current) taRef.current.style.height = '34px';
				try {
					await onSend(text, volume);
				} finally {
					setSending(false);
				}
			};
			return h(
				'div',
				{ className: 'cnx-card cnx-dialogcol' },
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', marginBottom: '6px' } },
					h('div', { className: 'cnx-char-name' }, '💬 家里的话'),
					h(
						'span',
						{
							className:
								'cnx-stream' + (stream === 'live' ? ' live' : stream === 'down' ? ' down' : ''),
							title:
								stream === 'live'
									? '实时事件流已连接'
									: stream === 'down'
										? '实时连接断开，正在慢速同步（每 20 秒）'
										: '正在建立实时连接……',
						},
						stream === 'live' ? '● 实时' : stream === 'down' ? '○ 已断开·慢速同步中' : '◌ 连接中',
					),
				),
				h(
					'div',
					{ className: 'cnx-msgs', ref: boxRef, onScroll: onBoxScroll },
					lines === null
						? h('div', { className: 'cnx-msgs-empty' }, '翻家里的聊天记录……')
						: lines.length === 0
							? h('div', { className: 'cnx-msgs-empty' }, '这个时间片里家里还很安静，说句话吧～')
							: lines.map((l, i) =>
									h(
										'div',
										{
											key: l.key || i,
											className: 'cnx-msgrow' + (l.who === 'master' ? ' master' : ''),
										},
										h(Face, { who: l.who, name: l.who, cls: 'cnx-avatar' }),
										h(
											'div',
											{ className: 'cnx-msgcol' },
											h(
												'div',
												{ className: 'cnx-msg-who' },
												(l.type === 'shout' ? '📢 ' : '') + displayName(l.who),
												volTag(l.volume)
													? h('span', { className: 'cnx-voltag' }, volTag(l.volume))
													: null,
											),
											h(
												'div',
												{ className: 'cnx-msg ' + msgClass(l.who) + volClass(l.volume) },
												l.action ? h('span', { className: 'cnx-action' }, '（' + l.action + '）') : null,
												l.text,
											),
										),
									),
								),
					drafting
						? h(
								'div',
								{
									key: 'drafting',
									className: 'cnx-msgrow' + (drafting.dropped ? ' cnx-unsaid' : ''),
								},
								h(Face, { who: drafting.char, name: drafting.name, cls: 'cnx-avatar' }),
								h(
									'div',
									{ className: 'cnx-msgcol' },
									h(
										'div',
										{ className: 'cnx-msg-who' },
										drafting.dropped
											? drafting.name + '（这句话没能说出口，没进账本）'
											: drafting.name + '（正在说……）',
									),
									h(
										'div',
										{ className: 'cnx-msg ' + msgClass(drafting.char) + ' cnx-drafting' },
										drafting.buf || '…',
										drafting.dropped ? null : h('span', { className: 'cnx-cursor' }, '▍'),
									),
								),
							)
						: null,
				),
				waiting
					? h('div', { className: 'cnx-waiting' }, '💭 ' + waiting + ' 正在想怎么回你……')
					: null,
				sysNotes && sysNotes.length > 0
					? h(
							'div',
							null,
							sysNotes.map((n) => h('div', { key: n.id, className: 'cnx-sysnote' }, n.text)),
						)
					: null,
				// 输入区：一张卡＝输入框本身（文本域在上，工具行贴右下）。
				// 音量＝上拉菜单（按钮显示当前档，点开往上弹）；说键＝框内右下角。
				h(
					'div',
					{ className: 'cnx-inputbox' },
					h('textarea', {
						ref: taRef,
						className: 'cnx-input',
						value: draft,
						placeholder: '和家里说点什么……',
						rows: 1,
						onChange: (e) => {
							setDraft(e.target.value);
							autoGrow();
						},
						onKeyDown: (e) => {
							if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								send();
							}
						},
						disabled: sending,
					}),
					h(
						'div',
						{ className: 'cnx-inputfoot' },
						h(
							'div',
							{ className: 'cnx-volwrap', ref: volRef },
							h(
								'button',
								{
									className: 'cnx-volbtn' + (volume === '正常' ? '' : ' active'),
									title: '说话音量（点开选）',
									onClick: () => setVolOpen((o) => !o),
									disabled: sending,
								},
								volume === '正常' ? '音量：正常' : '音量：' + volume,
								h('span', { className: 'cnx-caret' }, volOpen ? '▾' : '▴'),
							),
							volOpen
								? h(
										'div',
										{ className: 'cnx-volmenu' },
										SAY_VOLUMES.map((v) =>
											h(
												'button',
												{
													key: v,
													className: 'cnx-volitem' + (v === volume ? ' cur' : ''),
													onClick: () => {
														setVolume(v);
														setVolOpen(false);
													},
												},
												(v === volume ? '✓ ' : '　') + v,
											),
										),
										h('div', { className: 'cnx-volhint' }, VOLUME_HINT[volume] || ''),
									)
								: null,
						),
						h(
							'button',
							{
								className: 'cnx-btn primary',
								style: { marginLeft: 'auto' },
								disabled: sending || !draft.trim(),
								onClick: send,
								title: '说给她听（Enter）',
							},
							sending ? '…' : '说',
						),
					),
				),
				h('div', { className: 'cnx-sendhint' }, 'Enter 发送 · Shift+Enter 换行'),
			);
		}

		function displayName(who) {
			if (who === 'kyu') return '小玖';
			if (who === 'moli') return '墨璃';
			if (who === 'master') return '主人';
			return who;
		}
		function msgClass(who) {
			if (who === 'kyu') return 'kyu';
			if (who === 'moli') return 'moli';
			if (who === 'master') return 'master';
			return '';
		}
		// 音量→气泡字号（§9.16）：小声不缩小（只淡+斜），大声放大加粗；缺省（旧行/正常）不加类
		function volClass(volume) {
			if (volume === '小声') return ' v-low';
			if (volume === '大声') return ' v-high';
			return '';
		}
		// 名字后面的音量小标：光靠字号不够明确，给它一个说得出口的名字
		function volTag(volume) {
			if (volume === '小声') return '（小声）';
			if (volume === '大声') return '（大声）';
			return '';
		}
		const SAY_VOLUMES = ['小声', '正常', '大声'];
		const VOLUME_HINT = {
			小声: '悄悄话：只有同一间屋子的人听得见，隔壁什么都不知道',
			正常: '正常音量：隔壁隐约听得见（攒够几次才会反应）',
			大声: '喊一声：隔壁听得清清楚楚，当场被叫醒；再远一间也隐约听得到',
		};

		// 换模型入口：与工作模式选择器写同一个宿主默认选择（agentDefaultModel）。
		// provider 一级懒加载 models/<id>；选中即生效，全家角色立刻跟随。
		function ModelPicker() {
			const [open, setOpen] = react.useState(false);
			const [info, setInfo] = react.useState(null); // {current:{provider,model}, providers:[]}
			const [expanded, setExpanded] = react.useState(null);
			const [models, setModels] = react.useState({}); // providerId -> [] | null(加载中)
			const [busyModel, setBusyModel] = react.useState(null);
			const load = () =>
				fetch('/catnest/api/models')
					.then((r) => r.json())
					.then((d) => setInfo(d))
					.catch(() => setInfo(null));
			const pickProvider = (pid) => {
				if (expanded === pid) {
					setExpanded(null);
					return;
				}
				setExpanded(pid);
				if (!models[pid]) {
					setModels((prev) => ({ ...prev, [pid]: null }));
					fetch('/catnest/api/models/' + encodeURIComponent(pid))
						.then((r) => r.json())
						.then((d) => setModels((prev) => ({ ...prev, [pid]: d.models || [] })))
						.catch(() => setModels((prev) => ({ ...prev, [pid]: [] })));
				}
			};
			const pickModel = async (pid, mid) => {
				setBusyModel(pid + '/' + mid);
				try {
					await act({ op: 'selectModel', provider: pid, model: mid });
					await load();
					setOpen(false);
					setExpanded(null);
				} catch (e) {
					pushGlobalNote('换模型没成功：' + String(e && e.message ? e.message : e));
				} finally {
					setBusyModel(null);
				}
			};
			const cur = info && info.current;
			return h(
				'div',
				{ className: 'cnx-modelpick' },
				h(
					'button',
					{
						className: 'cnx-modelbtn',
						title: '猫窝说话用的模型（和工作模式共用同一选择）',
						onClick: () => {
							setOpen(!open);
							if (!open && !info) load();
						},
					},
						h('span', null, '🧶'),
						h('span', { className: 'cnx-mname' }, cur ? cur.model : '选模型'),
					),
				open
					? h(
						'div',
						{ className: 'cnx-modelmenu' },
						h('div', { className: 'cnx-mtitle' }, '🧶 家里说话用的模型 · 与工作模式共用'),
						info === null
							? h('div', { className: 'cnx-mdim' }, '读不出来……服务可能在睡觉')
							: !cur
								? h('div', { className: 'cnx-mdim' }, '当前没有默认模型')
								: (info.providers || []).map((pid) =>
										h(
										'div',
										{ key: pid },
										h(
											'button',
											{
												className: 'cnx-mgroup' + (cur.provider === pid ? ' active' : ''),
												onClick: () => pickProvider(pid),
											},
												h('span', { className: 'cnx-mdot' }),
												h('span', null, pid),
												h('span', { style: { marginLeft: 'auto', fontSize: '10px', color: 'var(--cnx-sub)' } }, expanded === pid ? '收起 ▴' : '展开 ▾'),
											),
											expanded === pid
												? h(
													'div',
													{ className: 'cnx-msub' },
													models[pid] == null
														? h('div', { className: 'cnx-mdim' }, '翻模型列表……')
														: models[pid].length === 0
															? h('div', { className: 'cnx-mdim' }, '这个 provider 没报出模型')
															: models[pid].map((mid) => {
																	const active = cur.provider === pid && cur.model === mid;
																	return h(
																		'button',
																		{
																			key: mid,
																			className: 'cnx-mitem' + (active ? ' active' : ''),
																			disabled: !!busyModel,
																			onClick: () => pickModel(pid, mid),
																		},
																		active ? h('span', { className: 'cnx-mcheck' }, '✓') : h('span', { style: { width: '13px' } }),
																		h('span', { className: 'cnx-mid' }, mid),
																	);
																}),
												)
												: null,
										),
									),
					)
				: null,
		);
	}
	// ModelPicker 用的全局提示（挂在 window 级 store，HomeWorkspace 订阅显示）
		const noteStore = { listeners: new Set() };
		const pushGlobalNote = (text) => {
			noteStore.latest = { text, at: Date.now() };
			noteStore.listeners.forEach((f) => f());
		};

		let lineSeq = 0;
		function HomeWorkspace() {
			const [data, setData] = react.useState(null);
			const [err, setErr] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [lines, setLines] = react.useState(null);
			const [says, setSays] = react.useState({});
			const [note, setNote] = react.useState(null);
			const [svgText, setSvgText] = react.useState(null);
			const [stream, setStream] = react.useState('connecting');
			const [waiting, setWaiting] = react.useState(null); // '小玖、墨璃' 正在想
			const [sysNotes, setSysNotes] = react.useState([]); // 失败提示（不进对话流，防快照覆盖）
			const [drafting, setDrafting] = react.useState(null); // {char,name,buf} 打字机气泡
			const autoOpened = react.useRef(false);
			const baselineLen = react.useRef(0); // 已结算的消息条数（用于逐人划掉等待名单）
			const noteSeq = react.useRef(0);
			const waitTimer = react.useRef(null);
			const dropTimer = react.useRef(null); // 「没能说出口」的灰气泡多久后自行消散

			// 小地图该切哪一栏：跟着人走（主人在小区就看小区，出门散步时才看得到自己在哪儿）。
			// 由 data 现算，不用单独存 state。
			const areaNow = areaOf(data);
			// 放大版（全图）的尺寸：量出来再定像素（ratio = 画布 1140:720）
			const zoomFit = useFitBox(1140 / 720);

			// 系统提示条：失败/异常可见化，12s 自动消散
			const pushSysNote = (text) => {
				const id = 'n' + ++noteSeq.current;
				setSysNotes((prev) => [...prev, { id, text }]);
				setTimeout(() => {
					setSysNotes((prev) => prev.filter((n) => n.id !== id));
				}, 12000);
			};
			// 模型选择器的全局提示也走同一出口（换模型失败等）
			react.useEffect(() => {
				const fn = () => {
					if (noteStore.latest && noteStore.latest.text) pushSysNote(noteStore.latest.text);
				};
				noteStore.listeners.add(fn);
				return () => {
					noteStore.listeners.delete(fn);
				};
			}, []);

			react.useEffect(() => {
				let alive = true;
				fetchPlanSvg()
					.then((t) => alive && setSvgText(t))
					.catch(() => {});
				// 初始全量拉一次（SSE 首帧也会推，双保险谁先到都行）
				Promise.all([
					fetchState(),
					fetch('/catnest/api/dialogue').then((r) => r.json()),
				])
					.then(([s, d]) => {
						if (!alive) return;
						setData(s);
						setLines(d.lines || []);
						baselineLen.current = (d.lines || []).length;
						// 进入猫窝联动：未开片自动开（每次挂载只试一次）
						if (!autoOpened.current && !(s.status && s.status.open)) {
							autoOpened.current = true;
							act({ op: 'open' })
								.then(() => {
									if (!alive) return;
									setNote('回家啦～已经帮你开好时间片，收工时点「关片」就好喵');
									setTimeout(() => alive && setNote(null), 6000);
								})
								.catch(() => {
									/* 开片失败静默，顶栏可手动 */
								});
						}
					})
					.catch((e) => alive && setErr(String(e && e.message ? e.message : e)));
				// 实时事件流：快照 + 打字机 delta + 点名台词 + 失败提示；断流自动降级轮询兜底
				// 等待名单按【具体角色的台词落地】逐人划账（v4 首版一刀切清空，
				// 导致墨璃还在想、小玖的等待提示先消失的误判）
				const settleWaitingBy = (names) => {
					setWaiting((prev) => {
						if (!prev) return prev;
						const rest = prev.split('、').filter((n) => n && names.indexOf(n) < 0);
						return rest.length > 0 ? rest.join('、') : null;
					});
				};
				// 台词没入账时的收尾（2026-09-15 主人定案）：不能直接把气泡抹掉——主人刚看到打字机
				// 吐出来的字凭空消失，只会以为是自己眼花（墨璃那次就是）。有话就灰在原地停 12 秒并
				// 标明「没能说出口」，没话才直接收。
				const dropDrafting = (name) => {
					setDrafting((prev) => {
						if (!prev || prev.name !== name) return prev;
						if (!prev.buf) return null;
						if (dropTimer.current) clearTimeout(dropTimer.current);
						dropTimer.current = setTimeout(() => {
							setDrafting((p) => (p && p.dropped ? null : p));
						}, 12000);
						return { ...prev, dropped: true };
					});
				};
				const disposeStream = connectEvents(
					(evt) => {
						if (!alive) return;
						if (evt.kind === 'snapshot') {
							setData(evt.state);
							setErr(null);
							if (evt.dialogue) {
								const fresh = evt.dialogue.lines || [];
								setLines(fresh);
								if (fresh.length > baselineLen.current) {
									// 新落地的台词属于谁，就把谁从等待名单划掉
									const landed = fresh
										.slice(baselineLen.current)
										.map((l) => displayName(l.who));
									baselineLen.current = fresh.length;
									settleWaitingBy(landed);
									// 正式消息已入账 → 只收【已落地角色】的打字机气泡。
									// 不能无差别清空：串行链里下一位的 deltaStart 可能先于
									// 本快照到达，一刀切会掐死正在直播的气泡（竞态 bug）。
									setDrafting((prev) =>
										prev && landed.indexOf(prev.name) >= 0 ? null : prev,
									);
								}
							}
						} else if (evt.kind === 'deltaStart' && evt.char) {
							setDrafting({ char: evt.char, name: evt.name || displayName(evt.char), buf: '' });
							setErr(null);
						} else if (evt.kind === 'delta' && evt.char) {
							setDrafting((prev) =>
								prev && prev.char === evt.char
									? { ...prev, buf: prev.buf + String(evt.text || '') }
									: prev,
							);
						} else if (evt.kind === 'deltaEnd' && evt.char) {
							// 生成结束：正式消息马上由 snapshot 带来；若没产生过任何字
							//（超时/失败）直接收掉气泡，等 replyError 或 snapshot 结算
							setDrafting((prev) => (prev && prev.char === evt.char && !prev.buf ? null : prev));
						} else if (evt.kind === 'reaction' && evt.char) {
							const stamp = Date.now();
							setSays((prev) => ({ ...prev, [evt.char]: evt.text }));
							setTimeout(() => {
								setSays((prev) => {
									if (!prev[evt.char]) return prev;
									const next = { ...prev };
									delete next[evt.char];
									return next;
								});
							}, 10000);
						} else if (evt.kind === 'replyError' && evt.name) {
							pushSysNote('（' + evt.name + '好像走神了，没接上话……稍后若想起来了会自己补上的喵）');
							settleWaitingBy([evt.name]);
							dropDrafting(evt.name);
						} else if (evt.kind === 'settle' && evt.name) {
							// 角色结算（沉默/超时/异常步）：收掉「正在想」等待名单。
							// said=false（这一轮确实没有台词落账）才把打字机气泡转成「没能说出口」；
							// said=true 就交给随后到达的快照收掉（§9.17 前是一律灰掉，快照晚到时
							// 会闪一下灰，主人 2026-09-16 看到的那条就是真失败+旧样式的叠加）
							settleWaitingBy([evt.name]);
							if (evt.said !== true) dropDrafting(evt.name);
						}
					},
					(st) => alive && setStream(st),
				);
				return () => {
					alive = false;
					disposeStream();
					if (waitTimer.current) clearTimeout(waitTimer.current);
				};
			}, []);

			const run = async (fn) => {
				setBusy(true);
				try {
					return await fn();
				} catch (e) {
					setErr(String(e && e.message ? e.message : e));
					return null;
				} finally {
					setBusy(false);
					fetchState()
						.then((s) => setData(s))
						.catch(() => {});
				}
			};
			const openSlice = () => run(() => act({ op: 'open' }));
			const closeSlice = () =>
				run(() => act({ op: 'close' })).then(() => {
					setNote('已关片，收尾蒸馏正在后台整理大家的记忆喵');
					setTimeout(() => setNote(null), 6000);
				});
			const moveMaster = (room) => run(() => act({ op: 'moveMaster', room }));
			// 在家自由互动开关（离家那档不受影响）：主人在家时才显示、才有效
			const toggleAutonomy = (next) => run(() => act({ op: 'autonomy', homeOn: next }));
			const callChar = (char) =>
				run(async () => {
					const r = await act({ op: 'interruptReaction', char });
					// reaction 走 SSE 即时推；这里只对 llm 缺席的兜底文案做本地显示
					if (!(r && typeof r.reaction === 'string' && r.reaction)) {
						const text =
							r && r.activity ? '（正忙着' + r.activity + '，没搭理你）' : '（发了一会儿呆……）';
						setSays((prev) => ({ ...prev, [char]: text }));
						setTimeout(() => {
							setSays((prev) => {
								if (!prev[char]) return prev;
								const next = { ...prev };
								delete next[char];
								return next;
							});
						}, 10000);
					}
					return r;
				});
			// 主人说话：乐观上屏（真实台词随后从 SSE 流里冒出来），失败把错误吐进气泡。
			// 有角色排进接话链就显示等待提示；结果（台词/失败提示）落地后逐个划掉。
			const sayToHome = async (text, volume) => {
				const vol = volume || '正常';
				setLines((prev) => [
					...(prev || []),
					{ key: 'opt-' + ++lineSeq, who: 'master', type: 'say', text, volume: vol },
				]);
				try {
					const r = await act({ op: 'say', text, volume: vol });
					const pendingNames = (r && Array.isArray(r.pending) && r.pending) || [];
					if (waitTimer.current) clearTimeout(waitTimer.current);
					if (pendingNames.length > 0) {
						baselineLen.current = (lines || []).length + 1; // 刚乐观 append 了主人这句
						setWaiting(pendingNames.join('、'));
						// 兜底：90s 仍无任何结果落地就明说（防事件丢失时永远转圈）
						waitTimer.current = setTimeout(() => {
							setWaiting((prev) => {
								if (!prev) return prev;
								pushSysNote('（等了好一会儿也没人接话……模型可能开小差了，稍后再试或换句话聊聊喵）');
								return null;
							});
						}, 90000);
					}
				} catch (e) {
					pushSysNote('（没说出去：' + String(e && e.message ? e.message : e) + '）');
				}
			};

			const st = data && data.status;
			const isOpen = !!(st && st.open);
			const [zoom, setZoom] = react.useState(false);

			return h(
				'div',
				{ className: 'cnx-full' },
				h(
					'div',
					{ className: 'cnx-head' },
					h('button', { className: 'cnx-btn', disabled: busy, onClick: () => setMode(false) }, '← 回到工作台'),
					h('span', { className: 'cnx-title' }, '🏠 猫窝'),
					isOpen
						? h('span', { className: 'cnx-badge on' }, '时间片进行中')
						: h('span', { className: 'cnx-badge' }, '未开片'),
					isOpen
						? h('button', { className: 'cnx-btn', disabled: busy, onClick: closeSlice }, '关片')
						: h('button', { className: 'cnx-btn primary', disabled: busy, onClick: openSlice }, '开片'),
					h(ModelPicker, null),
					// 大地图 §3：主人位置三态（在家 / 在小区 / 出远门）。
					// 「在小区」是可寻址的——她看得见你在步道上，能过来找你。
					data && data.master && data.master.place && data.master.place.kind !== 'away'
						? h(
								'span',
								{ className: 'cnx-badge', title: '主人的位置' },
								'📍 ' + (data.master.label || ''),
							)
						: null,
					data && data.master && data.master.place && data.master.place.kind !== 'away'
						? h(
								'button',
								{
									className: 'cnx-btn' + (data.autonomy && data.autonomy.homeOn ? ' primary' : ''),
									disabled: busy,
									title: '主人可寻址时，也让她们自己找话说、自己找事做（出远门后的自由互动不受影响）',
									onClick: () => toggleAutonomy(!(data.autonomy && data.autonomy.homeOn)),
								},
								data.autonomy && data.autonomy.homeOn ? '自由互动：开' : '自由互动：关',
							)
						: null,
					// 位置切换：出远门（退出地图）↔ 回家（客厅）；在小区里时给一条回屋的路
					data && data.master && data.master.place && data.master.place.kind === 'away'
						? h(
								'button',
								{ className: 'cnx-btn', disabled: busy, onClick: () => moveMaster('living') },
								'主人回家',
							)
						: h(
								'button',
								{ className: 'cnx-btn', disabled: busy, onClick: () => moveMaster(null) },
								'主人出远门',
							),
					data && data.master && data.master.place && data.master.place.kind === 'yard'
						? h(
								'button',
								{ className: 'cnx-btn', disabled: busy, onClick: () => moveMaster('living') },
								'主人回屋',
							)
						: h(
								'button',
								{
									className: 'cnx-btn',
									disabled: busy,
									title: '走到小区里（月见庭）：她看得见你，能过来找你',
									onClick: () => moveMaster('unit_door'),
								},
								'去小区',
							),
				),
				note ? h('div', { className: 'cnx-note' }, note) : null,
				err ? h('div', { className: 'cnx-err' }, '⚠ ' + err) : null,
				h(
					'div',
					{ className: 'cnx-body' },
					// 左：窄导航列（小地图 + 回顾）
					h(
						'div',
						{ className: 'cnx-navcol' },
						h(
							'div',
							{
								className: 'cnx-card cnx-mapcard cnx-minimap',
								title: '点击放大地图',
								onClick: () => setZoom(true),
							},
							// 比例锁：家 (760×720) 与小区 (400×720 补齐成 760×720) 同一把尺子，
							// 切范围时格子大小不变（不然小区那块会显得又瘦又长）
							h('div', { className: 'cnx-mini-inner' },
							h(MapPanel, {
								data,
								svgText,
								onMove: moveMaster,
								wrapClass: null,
								area: areaNow, // 小地图只显示当前那一栏（家内 / 小区）
							}),
							),
							h('span', { className: 'cnx-zoomhint' }, '🔍 放大'),
						),
						data && data.recap
							? h('div', { className: 'cnx-card cnx-recap' }, '上次：' + data.recap)
							: null,
					),
					// 中：家里的话（客厅主体）
					h(DialoguePanel, { lines, says, onSend: sayToHome, stream, waiting, sysNotes, drafting }),
					// 右：全员状态卡 + 家当（HOUSE_DESIGN §1/§2：这边栏更宽、可滚动）
					h(
						'div',
						{ className: 'cnx-side' },
						(data && data.characters ? data.characters : []).map((c) =>
							h(CharCard, {
								key: c.id,
								c,
								relations: (data && data.relations) || {},
								busy,
								onCall: callChar,
								say: says[c.id] || null,
							}),
						),
						h(ThingsCard, { data }),
					),
				),
				zoom
					? h(
							'div',
							{
								className: 'cnx-lightbox',
								onClick: (e) => {
									if (e.target === e.currentTarget) setZoom(false);
								},
							},
							h(
								'div',
								{ className: 'cnx-lightbox-card' },
								h(
									'div',
									{ className: 'cnx-head', style: { marginBottom: '8px' } },
									h('span', { className: 'cnx-title' }, '🗺 户型图'),
									h(
										'span',
										{ className: 'cnx-badge' },
										'点房间把主人移过去 · 点空白处关闭',
									),
									h('button', { className: 'cnx-btn', onClick: () => setZoom(false) }, '✕'),
								),
								h(
									'div',
									{ className: 'cnx-zoombox', ref: zoomFit.setBox },
									h(
										'div',
										{
											className: 'cnx-zoomfit',
											ref: zoomFit.setMap,
											style: zoomFit.size
												? { width: zoomFit.size.w + 'px', maxWidth: 'none' }
												: null,
										},
										h(MapPanel, {
											data,
											svgText,
											onMove: moveMaster,
											wrapClass: null,
											area: null,
											fixedSize: zoomFit.size,
										}),
									),
								),
							),
						)
					: null,
			);
		}

		// ── 插件体 ──
		function apply(ctx) {
			injectStyles();
			const slots = ctx.slots;
			ctx.effect(() =>
				slots.inject('sidebar.footer.action', () =>
					slots.register({ name: 'sidebar.footer.action', id: 'catnest-entry', order: 20 }, Entry),
				),
			);
			ctx.effect(() =>
				slots.inject('shell.overlay', () =>
					slots.register({ name: 'shell.overlay', id: 'catnest-workspace', order: 10 }, Panel),
				),
			);
		}
		const inject = ['slots'];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
