import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import { WorkflowVisualizerJson } from "orkes-workflow-visualizer";
import { toPng } from "dom-to-image";
import { buildGraph, summarize } from "./graph.js";
import { toMermaid } from "./mermaid.js";
// conductor-validate 的离线校验核心（浏览器构建，见 tsconfig.viewer.json）。
// 页面不实现任何规则：规则、路径、严重级别全部来自这里，和 CLI 是同一份代码。
import { Linter, lintDefinition, ruleCatalog, SEVERITY_ORDER } from "./vendor/core.js";

const html = htm.bind(React.createElement);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 严重级别的中文说法（纯 UI 文案，级别本身由 conductor-validate 定义） */
const SEVERITY_LABEL = { CRITICAL: "严重", WARN: "警告", INFO: "提示" };

/** 规则说明：id → { id, severity, description }，同样来自 conductor-validate */
const RULES_BY_ID = new Map(ruleCatalog().map((r) => [r.id, r]));

/**
 * orkes-workflow-visualizer 没有内置 fitView，而且每次渲染都会把画布 <g> 的 transform
 * 重置成它自己的「居中」值（translateX/translateY/scale 写在内联 style 里），
 * 直接改画布层的 transform 会被覆盖。
 *
 * 所以缩放、定位、平移都放在组件外面的 viewport 容器上做，互不干扰。
 * 平移量 pan 叠加在「居中 + 缩放」之上，库重绘时不会把用户拖动的位置冲掉。
 *
 * 定位基于实测节点包围盒：elk 布局给出的 width/height 与实际渲染尺寸并不一致
 * （foreignObject 里的 HTML 内容会溢出），直接用布局尺寸会把首尾节点裁掉。
 */
function useGraphView(hostRef, viewportRef, hostEl) {
  const [layout, setLayout] = useState(null);
  const [scale, setScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const scaleRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const bboxRef = useRef(null);
  const sigRef = useRef("");
  const timerRef = useRef(null);
  const stableTimerRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const flashRef = useRef(null);

  /** 实测内容在 viewport 坐标系里的包围盒 */
  const measure = useCallback(() => {
    const host = hostRef.current;
    const vp = viewportRef.current;
    const svg = host?.querySelector("svg");
    const layer = svg?.querySelector(":scope > g");
    if (!host || !vp || !svg || !layer) return null;

    // 主画布默认 overflow:hidden + 固定尺寸，会裁掉超出部分
    svg.classList.add("wf-canvas");

    const prevTransform = vp.style.transform;
    vp.style.transform = "none";
    const vpRect = vp.getBoundingClientRect();

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    layer.querySelectorAll("foreignObject").forEach((fo) => {
      const r = (fo.firstElementChild || fo).getBoundingClientRect();
      if (!r.width && !r.height) return;
      const x = r.left - vpRect.left;
      const y = r.top - vpRect.top;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + r.width);
      maxY = Math.max(maxY, y + r.height);
    });

    vp.style.transform = prevTransform;
    if (!isFinite(minX) || !isFinite(minY)) return null;
    return { minX, minY, maxX, maxY };
  }, [hostRef, viewportRef]);

  /** 把内容按给定缩放比摆到 viewport 中心，再叠加平移量 */
  const applyTransform = useCallback(
    (bbox, s, pan) => {
      const vp = viewportRef.current;
      if (!vp || !bbox) return;
      const centerX = (bbox.minX + bbox.maxX) / 2;
      const centerY = (bbox.minY + bbox.maxY) / 2;
      const tx = vp.clientWidth / 2 - s * centerX + pan.x;
      const ty = vp.clientHeight / 2 - s * centerY + pan.y;
      vp.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    },
    [viewportRef]
  );

  /** keepPan=true 用于自动重新适配（布局变化/容器 resize），保留用户拖动的位置 */
  const fit = useCallback(
    (attempt = 0, keepPan = false) => {
      const bbox = measure();
      if (!bbox) return;
      bboxRef.current = bbox;

      const vp = viewportRef.current;
      if (!vp) return;
      const contentW = Math.max(1, bbox.maxX - bbox.minX);
      const contentH = Math.max(1, bbox.maxY - bbox.minY);
      const pad = 48;
      const next = clamp(
        Math.min((vp.clientWidth - pad) / contentW, (vp.clientHeight - pad) / contentH),
        0.15,
        1.25
      );
      scaleRef.current = next;
      setScale(next);
      if (!keepPan) panRef.current = { x: 0, y: 0 };
      applyTransform(bbox, next, panRef.current);

      // 节点是分批渲染的，稍后再量一次；内容变大了就重新适配
      if (attempt < 5) {
        clearTimeout(stableTimerRef.current);
        stableTimerRef.current = setTimeout(() => {
          if (dragRef.current) return; // 拖动中不重新测量，避免画面跳动
          const b2 = measure();
          if (!b2) return;
          const grew =
            b2.maxY - b2.minY > contentH + 2 || b2.maxX - b2.minX > contentW + 2;
          if (grew) fit(attempt + 1, keepPan);
        }, 280);
      }
    },
    [measure, applyTransform, viewportRef]
  );

  /** 以 anchor（viewport 局部坐标）为锚点缩放，锚点下的内容保持不动 */
  const zoom = useCallback(
    (factor, anchor) => {
      const bbox = bboxRef.current;
      const vp = viewportRef.current;
      if (!bbox || !vp) return;
      const cur = scaleRef.current;
      const next = clamp(cur * factor, 0.15, 3);
      if (next === cur) return;

      const centerX = (bbox.minX + bbox.maxX) / 2;
      const centerY = (bbox.minY + bbox.maxY) / 2;
      const pan = panRef.current;
      // 当前实际的 translate（居中 + 平移）
      const baseX = vp.clientWidth / 2 - cur * centerX + pan.x;
      const baseY = vp.clientHeight / 2 - cur * centerY + pan.y;
      const ax = anchor ? anchor.x : vp.clientWidth / 2;
      const ay = anchor ? anchor.y : vp.clientHeight / 2;
      // 锚点对应的内容坐标
      const contentX = (ax - baseX) / cur;
      const contentY = (ay - baseY) / cur;
      const nextBaseX = ax - next * contentX;
      const nextBaseY = ay - next * contentY;
      panRef.current = {
        x: nextBaseX - (vp.clientWidth / 2 - next * centerX),
        y: nextBaseY - (vp.clientHeight / 2 - next * centerY),
      };
      scaleRef.current = next;
      setScale(next);
      applyTransform(bbox, next, panRef.current);
    },
    [applyTransform, viewportRef]
  );

  // 布局尺寸变化时重新适应视图
  const sig = useMemo(() => {
    if (!layout) return "";
    const w = layout.width ?? layout.canvas?.width ?? 0;
    const h = layout.height ?? layout.canvas?.height ?? 0;
    return `${Math.round(w)}x${Math.round(h)}`;
  }, [layout]);

  const scheduleFit = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // 自动重新适配时保留用户拖动的位置
    timerRef.current = setTimeout(() => fit(0, true), 140);
  }, [fit]);

  useEffect(() => {
    if (!sig || sig === sigRef.current) return;
    sigRef.current = sig;
    scheduleFit();
  }, [sig, scheduleFit]);

  // 节点是分批渲染进 DOM 的，内容就位后需要重新测量一次
  useEffect(() => {
    let observer = null;
    let timer = null;

    const attach = () => {
      const host = hostRef.current;
      if (!host) {
        timer = setTimeout(attach, 100);
        return;
      }
      const svg = host.querySelector("svg");
      const layer = svg?.querySelector(":scope > g");
      if (!layer) {
        timer = setTimeout(attach, 120);
        return;
      }
      observer = new MutationObserver(() => {
        if (dragRef.current) return; // 拖动过程中不要重新测量，避免画面跳动
        scheduleFit();
      });
      observer.observe(layer, { childList: true, subtree: true });
    };
    attach();

    return () => {
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [hostRef, scheduleFit]);

  // 容器尺寸变化时重新适应
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    let ro = null;
    let timer = null;

    const attach = () => {
      const host = hostRef.current;
      if (!host) {
        timer = setTimeout(attach, 100);
        return;
      }
      ro = new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (dragRef.current) return; // 拖动中不重新适应
          fit(0, true);
        }, 150);
      });
      ro.observe(host);
    };
    attach();

    return () => {
      clearTimeout(timer);
      ro?.disconnect();
    };
  }, [fit, hostRef]);

  const onLayoutChange = useCallback((value) => {
    if (!value) return;
    setLayout(value.layout ?? value);
  }, []);

  // 拖拽平移 + 滚轮缩放
  useEffect(() => {
    if (!hostEl) return;

    const onPointerDown = (e) => {
      if (e.pointerType === "mouse") {
        if (e.button === 2) return; // 右键保留给浏览器菜单
        if (e.button === 1) e.preventDefault(); // 中键平移，避免触发自动滚动
      }
      if (!bboxRef.current) return;
      // 库内部节点有自己的手势（拖动/连线），这里抢在它们之前拦掉，避免和画布平移打架
      e.stopPropagation();
      suppressClickRef.current = false; // 新的一次手势，上一次拖动的 click 抑制可以解除
      dragRef.current = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
        moved: false,
      };
    };

    const onPointerMove = (e) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        drag.moved = true;
        setDragging(true);
      }
      panRef.current = { x: drag.panX + dx, y: drag.panY + dy };
      applyTransform(bboxRef.current, scaleRef.current, panRef.current);
    };

    const onPointerUp = (e) => {
      const drag = dragRef.current;
      if (!drag || (e && e.pointerId !== drag.id)) return;
      if (drag.moved) {
        // 拖动之后紧跟的 click 不应该被当成「选中节点」
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 400);
      }
      dragRef.current = null;
      setDragging(false);
    };

    const onClick = (e) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    };

    const onWheel = (e) => {
      if (!bboxRef.current) return;
      e.preventDefault();
      const rect = hostEl.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    };

    hostEl.addEventListener("pointerdown", onPointerDown, true);
    hostEl.addEventListener("click", onClick, true);
    hostEl.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    return () => {
      hostEl.removeEventListener("pointerdown", onPointerDown, true);
      hostEl.removeEventListener("click", onClick, true);
      hostEl.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [hostEl, zoom, applyTransform]);

  /** 找到某个任务在画布上的 DOM 元素（不同版本的库 id 规则略有差异，做兼容匹配） */
  const findNodeEl = useCallback(
    (ref) => {
      const host = hostRef.current;
      if (!host || !ref) return null;
      const layer = host.querySelector("svg > g");
      if (!layer) return null;
      for (const el of layer.querySelectorAll("g[id]")) {
        const id = el.getAttribute("id") || "";
        if (id === ref || id === `node-${ref}` || id.endsWith(`-${ref}`)) return el;
      }
      return null;
    },
    [hostRef]
  );

  /** 把某个任务节点平移到画布中心（配合校验结果「定位」用） */
  const focusRef = useCallback(
    (ref) => {
      const vp = viewportRef.current;
      const bbox = bboxRef.current;
      if (!vp || !bbox) return;
      const el = findNodeEl(ref);
      if (!el) return;
      const fo = el.querySelector("foreignObject");
      const box = (fo?.firstElementChild || fo || el).getBoundingClientRect();
      if (!box.width && !box.height) return;

      // 和 measure() 一样，先把 transform 归零再量，得到内容坐标系里的位置
      const prev = vp.style.transform;
      vp.style.transform = "none";
      const vpRect = vp.getBoundingClientRect();
      const cx = box.left + box.width / 2 - vpRect.left;
      const cy = box.top + box.height / 2 - vpRect.top;
      vp.style.transform = prev;

      const s = scaleRef.current;
      const centerX = (bbox.minX + bbox.maxX) / 2;
      const centerY = (bbox.minY + bbox.maxY) / 2;
      // 让节点的中心落在画布中心：pan = s * (内容中心 - 节点中心)
      panRef.current = { x: s * (centerX - cx), y: s * (centerY - cy) };
      applyTransform(bbox, s, panRef.current);

      // 高亮一下被定位的节点
      el.classList.add("wf-flash");
      clearTimeout(flashRef.current);
      flashRef.current = setTimeout(() => el.classList.remove("wf-flash"), 2800);
    },
    [applyTransform, findNodeEl, viewportRef]
  );

  return { scale, fit, zoom, dragging, focusRef, onLayoutChange };
}

const SAMPLES = [
  { file: "./samples/fork-join.json", label: "fork-join" },
  { file: "./samples/do-while-loop.json", label: "do-while-loop" },
  { file: "./samples/llm-chaining.json", label: "llm-chaining" },
  { file: "./samples/weather-notification.json", label: "weather-notification" },
  { file: "./samples/agent-fork-specialists.json", label: "agent-fork-specialists" },
  // conductor-validate 自带的样例：一个故意有问题，一个合法
  { file: "../examples/workflow_with_issues.json", label: "issues-demo" },
  { file: "../examples/valid_workflow.json", label: "valid-demo" },
];

function parseWorkflow(text) {
  let data = JSON.parse(text);
  // 兼容 { "workflowDef": {...} } 之类的包裹形式
  if (data && typeof data === "object" && data.workflowDef && data.workflowDef.tasks) {
    data = data.workflowDef;
  }
  if (!data || !Array.isArray(data.tasks)) {
    throw new Error("JSON 里没有找到 tasks 数组，不是合法的工作流定义。");
  }
  return data;
}

function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Toolbar({ wf, graphHostRef, onNotify, onValidate, onRules, validation, summary }) {
  const [busy, setBusy] = useState(false);

  const exportPng = async () => {
    if (!graphHostRef.current) return;
    setBusy(true);
    try {
      const dataUrl = await toPng(graphHostRef.current, { cacheBust: true, pixelRatio: 2 });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      download(`${wf?.name || "workflow"}.png`, blob, "image/png");
      onNotify("PNG 已导出");
    } catch (e) {
      onNotify(`PNG 导出失败: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportSvg = () => {
    const svg = graphHostRef.current?.querySelector("svg");
    if (!svg) {
      onNotify("没有找到可导出的 SVG");
      return;
    }
    const clone = svg.cloneNode(true);
    const css = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent || "")
      .join("\n");
    const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleEl.textContent = css;
    clone.insertBefore(styleEl, clone.firstChild);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = new XMLSerializer().serializeToString(clone);
    download(`${wf?.name || "workflow"}.svg`, xml, "image/svg+xml");
    onNotify("SVG 已导出");
  };

  const exportMermaid = () => {
    const text = toMermaid(wf);
    download(`${wf?.name || "workflow"}.mermaid.md`, text, "text/markdown");
    // 剪贴板可能被浏览器策略禁用，失败时只提示已下载
    let copied = null;
    try {
      copied = navigator.clipboard?.writeText(text);
    } catch {
      copied = null;
    }
    if (!copied) {
      onNotify("Mermaid 已下载");
      return;
    }
    copied.then(
      () => onNotify("Mermaid 已下载，并复制到剪贴板"),
      () => onNotify("Mermaid 已下载")
    );
  };

  const exportJson = () => {
    download(`${wf?.name || "workflow"}.json`, JSON.stringify(wf, null, 2), "application/json");
    onNotify("JSON 已导出");
  };

  return html`
    <header class="toolbar">
      <div class="brand">
        <span class="logo">◈</span>
        <div class="brand-text">
          <strong>Conductor Workflow Viewer</strong>
          ${wf
            ? html`<span class="wf-meta"
                >${wf.name || "(未命名)"} · v${wf.version ?? 1} · ${summary?.taskCount ?? 0} 个任务</span
              >`
            : html`<span class="wf-meta">拖入一个 workflow definition JSON 开始</span>`}
        </div>
      </div>
      <div class="actions">
        <button
          class="btn primary"
          disabled=${!wf}
          onClick=${onValidate}
          title="用 conductor-validate 的离线规则校验工作流合法性"
        >
          ✔ 校验
          ${validation && validation.findings.length
            ? html`<span class="btn-badge">${validation.findings.length}</span>`
            : null}
        </button>
        <button class="btn" disabled=${!wf} onClick=${onRules} title="查看规则手册">规则</button>
        <span class="act-sep"></span>
        <button class="btn" disabled=${!wf} onClick=${exportMermaid}>Mermaid</button>
        <button class="btn" disabled=${!wf || busy} onClick=${exportSvg}>SVG</button>
        <button class="btn" disabled=${!wf || busy} onClick=${exportPng}>PNG</button>
        <button class="btn ghost" disabled=${!wf} onClick=${exportJson}>JSON</button>
      </div>
    </header>
  `;
}

function Loader({ onLoad, onNotify }) {
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const handleFiles = useCallback(
    (fileList) => {
      const file = fileList?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          onLoad(parseWorkflow(String(reader.result)), file.name);
        } catch (e) {
          onNotify(`解析失败: ${e.message}`);
        }
      };
      reader.readAsText(file);
    },
    [onLoad, onNotify]
  );

  const applyText = () => {
    if (!text.trim()) return;
    try {
      onLoad(parseWorkflow(text), "粘贴的 JSON");
    } catch (e) {
      onNotify(`解析失败: ${e.message}`);
    }
  };

  const loadSample = async (file, label) => {
    try {
      const res = await fetch(file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onLoad(parseWorkflow(await res.text()), label);
    } catch (e) {
      onNotify(`示例加载失败: ${e.message}`);
    }
  };

  return html`
    <div class="loader">
      <div
        class=${"dropzone" + (dragOver ? " over" : "")}
        onDragOver=${(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave=${() => setDragOver(false)}
        onDrop=${(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick=${() => fileRef.current?.click()}
      >
        <div class="dz-icon">⇪</div>
        <div class="dz-title">拖入 workflow definition JSON</div>
        <div class="dz-sub">或点击选择文件</div>
        <input
          type="file"
          accept=".json,application/json"
          ref=${fileRef}
          style=${{ display: "none" }}
          onChange=${(e) => handleFiles(e.target.files)}
        />
      </div>

      <details class="paste-box">
        <summary>粘贴 JSON 文本</summary>
        <textarea
          value=${text}
          onChange=${(e) => setText(e.target.value)}
          placeholder='{ "name": "my-workflow", "tasks": [ ... ] }'
          rows=${8}
        ></textarea>
        <button class="btn primary" onClick=${applyText}>解析</button>
      </details>

      <div class="samples">
        <div class="section-title">示例</div>
        ${SAMPLES.map(
          (s) => html`<button class="chip" onClick=${() => loadSample(s.file, s.label)} key=${s.file}>
            ${s.label}
          </button>`
        )}
      </div>
    </div>
  `;
}

function SeverityBadge({ severity, small }) {
  return html`<span class=${"sev sev-" + severity.toLowerCase() + (small ? " small" : "")}>${severity}</span>`;
}

/** 单个属性值：对象/数组折叠成 JSON，其余直接显示 */
function PropertyValue({ value }) {
  if (value === null || value === undefined) {
    return html`<code class="prop-null">${String(value)}</code>`;
  }
  if (typeof value === "object") {
    const label = Array.isArray(value)
      ? `数组 · ${value.length} 项`
      : `对象 · ${Object.keys(value).length} 个字段`;
    return html`
      <details class="prop-json">
        <summary>${label}</summary>
        <pre>${JSON.stringify(value, null, 2)}</pre>
      </details>
    `;
  }
  if (typeof value === "boolean") return html`<code class="prop-bool">${String(value)}</code>`;
  if (typeof value === "number") return html`<code class="prop-num">${value}</code>`;
  return html`<code class="prop-str">${String(value)}</code>`;
}

/** 对象的全部属性，一行一个 */
function PropertyList({ obj }) {
  const keys = Object.keys(obj || {});
  if (keys.length === 0) return html`<div class="muted small-note">（没有属性）</div>`;
  return html`
    <div class="props">
      ${keys.map(
        (key) => html`
          <div class="prop-row" key=${key}>
            <div class="prop-key">${key}</div>
            <div class="prop-val">
              <${PropertyValue} value=${obj[key]} />
            </div>
          </div>
        `
      )}
    </div>
  `;
}

function TaskDetails({ node, findings, onCopy }) {
  if (!node) return null;
  const t = node.task || {};
  const keys = Object.keys(t);

  return html`
    <div class="details">
      <div class="detail-head">
        <span class=${"badge " + node.group}>${node.type}</span>
        <h3>${node.name}</h3>
        <code class="ref">${node.ref}</code>
      </div>
      <div class="detail-meta">
        <div class="meta-line">
          <span>定义位置</span>
          <code>${node.path || "-"}</code>
        </div>
        <div class="meta-line">
          <span>属性数量</span>
          <code>${keys.length}</code>
        </div>
      </div>

      ${findings && findings.length
        ? html`
            <div class="node-findings">
              <div class="section-title">该节点的问题 (${findings.length})</div>
              ${findings.map(
                (f, i) => html`
                  <div class=${"mini-finding sev-border-" + f.severity.toLowerCase()} key=${f.rule + i}>
                    <div class="mini-head">
                      <${SeverityBadge} severity=${f.severity} small=${true} />
                      <code class="rule-chip">${f.rule}</code>
                    </div>
                    <div class="mini-msg">${f.message}</div>
                    ${f.fix ? html`<div class="mini-fix">修复建议：${f.fix}</div>` : null}
                  </div>
                `
              )}
            </div>
          `
        : null}

      <div class="section-title">全部属性 (${keys.length})</div>
      <${PropertyList} obj=${t} />
      ${onCopy
        ? html`<button class="btn ghost full" onClick=${() => onCopy(t)}>复制节点 JSON</button>`
        : null}
    </div>
  `;
}

function WorkflowDetails({ wf }) {
  if (!wf) return null;
  return html`
    <div class="details">
      <div class="detail-head">
        <span class="badge sub">WORKFLOW</span>
        <h3>${wf.name || "(未命名)"}</h3>
      </div>
      <div class="section-title">全部属性 (${Object.keys(wf).length})</div>
      <${PropertyList} obj=${wf} />
    </div>
  `;
}

/** 校验结果面板 */
function ValidationPanel({ result, filter, onFilter, onLocate, onRerun, onOpenRule }) {
  if (!result) {
    return html`
      <div class="panel-empty">
        <div class="empty-art">✔</div>
        <p>还没有校验过这个工作流。</p>
        <button class="btn primary full" onClick=${onRerun}>运行 conductor-validate 校验</button>
      </div>
    `;
  }

  const { findings, counts } = result;
  const shown = filter === "ALL" ? findings : findings.filter((f) => f.severity === filter);

  return html`
    <div class="report">
      <div class="report-head">
        <div class="report-title">校验结果</div>
        <button class="btn small" onClick=${onRerun}>重新校验</button>
      </div>

      <div class="sev-summary">
        <button
          class=${"sev-chip all" + (filter === "ALL" ? " active" : "")}
          onClick=${() => onFilter("ALL")}
        >
          全部 ${findings.length}
        </button>
        ${["CRITICAL", "WARN", "INFO"].map(
          (s) => html`
            <button
              class=${"sev-chip sev-" + s.toLowerCase() + (filter === s ? " active" : "")}
              onClick=${() => onFilter(filter === s ? "ALL" : s)}
              title=${SEVERITY_LABEL[s]}
            >
              ${s} ${counts[s] || 0}
            </button>
          `
        )}
      </div>

      ${findings.length === 0
        ? html`<div class="report-ok">✔ 没有发现问题，工作流结构合法。</div>`
        : shown.length === 0
          ? html`<div class="report-ok">该级别下没有问题。</div>`
          : html`
              <div class="finding-list">
                ${shown.map(
                  (f, i) => html`
                    <div class=${"finding sev-border-" + f.severity.toLowerCase()} key=${f.rule + f.path + i}>
                      <div class="finding-head">
                        <${SeverityBadge} severity=${f.severity} />
                        <button class="rule-chip" title="查看规则手册" onClick=${() => onOpenRule(f.rule)}>
                          ${f.rule}
                        </button>
                        <code class="finding-path">${f.path}</code>
                      </div>
                      <div class="finding-msg">${f.message}</div>
                      ${f.fix ? html`<div class="finding-fix">修复建议：${f.fix}</div>` : null}
                      ${f.description
                        ? html`<div class="finding-rule">规则说明：${f.description}</div>`
                        : null}
                      ${f.graphRef
                        ? html`
                            <button class="locate" onClick=${() => onLocate(f.graphRef)}>
                              定位到节点 ${f.graphRef} →
                            </button>
                          `
                        : html`<div class="finding-rule muted">未关联到具体任务节点</div>`}
                    </div>
                  `
                )}
              </div>
            `}
    </div>
  `;
}

/** 规则手册：所有规则的说明 + 命中情况 */
function RuleBook({ findings, activeRule, onPickRule }) {
  const [query, setQuery] = useState("");
  const rules = ruleCatalog();
  const hits = new Map();
  for (const f of findings || []) hits.set(f.rule, (hits.get(f.rule) || 0) + 1);

  const q = query.trim().toLowerCase();
  const shown = rules.filter(
    (r) =>
      !q ||
      r.id.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      (r.severity || "").toLowerCase().includes(q)
  );

  return html`
    <div class="rulebook">
      <div class="report-head">
        <div class="report-title">规则手册</div>
        <span class="muted">${rules.length} 条规则</span>
      </div>
      <input
        class="rule-search"
        placeholder="搜索规则号 / 说明 / 级别…"
        value=${query}
        onInput=${(e) => setQuery(e.target.value)}
      />
      <div class="rule-list">
        ${shown.map(
          (r) => html`
            <button
              class=${"rule-item" + (activeRule === r.id ? " active" : "")}
              key=${r.id}
              onClick=${() => onPickRule(r.id)}
            >
              <span class=${"sev sev-" + r.severity.toLowerCase()}>${r.id}</span>
              <span class="rule-desc">${r.description}</span>
              ${hits.get(r.id) ? html`<span class="rule-hit">${hits.get(r.id)}</span>` : null}
            </button>
          `
        )}
      </div>
    </div>
  `;
}

function TaskList({ graph, selectedRef, onSelect, issues }) {
  const list = useMemo(
    () => graph.order.filter((ref) => ref !== graph.start && ref !== graph.end),
    [graph]
  );
  return html`
    <div class="task-list">
      <div class="section-title">任务 (${list.length})</div>
      ${list.map((ref) => {
        const node = graph.nodes.get(ref);
        const issue = issues?.get(ref);
        return html`
          <button
            class=${"task-item" + (selectedRef === ref ? " active" : "")}
            key=${ref}
            onClick=${() => onSelect(ref)}
            title=${issue ? `${issue.count} 个问题（${issue.severity}）` : node.path || ""}
          >
            <span class=${"dot " + node.group}></span>
            <span class="task-name">${node.name}</span>
            ${issue
              ? html`<span class=${"task-issue sev-" + issue.severity.toLowerCase()}>${issue.count}</span>`
              : null}
            <span class="task-type">${node.type}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function App() {
  const [wf, setWf] = useState(null);
  const [selectedRef, setSelectedRef] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showJson, setShowJson] = useState(false);
  const graphHostRef = useRef(null);
  const viewportRef = useRef(null);
  const fileInputRef = useRef(null);
  // 画布容器要拿到真实 DOM 元素来挂拖拽/滚轮事件
  const [graphHostEl, setGraphHostEl] = useState(null);
  const setGraphHost = useCallback((el) => {
    graphHostRef.current = el;
    setGraphHostEl(el);
  }, []);

  const notify = useCallback((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => {
    // 支持 view.sh 通过 ?file=xxx 直接加载工作流
    const param = new URLSearchParams(window.location.search).get("file");
    if (param) {
      fetch(param)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => {
          setWf(parseWorkflow(text));
          notify(`已加载 ${param}`);
        })
        .catch((err) => notify(`加载失败: ${err.message}`));
    }
  }, [notify]);

  useEffect(() => {
    const onDragOver = (e) => e.preventDefault();
    const onDrop = (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          setWf(parseWorkflow(String(reader.result)));
          setSelectedRef(null);
          notify(`已加载 ${file.name}`);
        } catch (err) {
          notify(`解析失败: ${err.message}`);
        }
      };
      reader.readAsText(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [notify]);

  // 每个工作流一个 linter 实例：只 collect()（建立任务树），不跑规则，
  // 于是可以反复用来查路径、查「问题属于哪个任务」，不会重复产出结果。
  const linter = useMemo(() => {
    if (!wf) return null;
    try {
      const instance = new Linter(wf);
      instance.collect();
      return instance;
    } catch {
      // 工作流结构不合法到连任务树都建不起来时，页面照常画图，只是没有路径
      return null;
    }
  }, [wf]);

  const graph = useMemo(() => (wf ? buildGraph(wf, linter) : null), [wf, linter]);
  const summary = useMemo(() => (wf ? summarize(wf, linter) : null), [wf, linter]);
  const selectedNode = selectedRef && graph ? graph.nodes.get(selectedRef) : null;
  const { scale, fit, zoom, dragging, focusRef, onLayoutChange } = useGraphView(
    graphHostRef,
    viewportRef,
    graphHostEl
  );

  // ---- 校验：直接跑 conductor-validate 的离线规则（浏览器构建）----
  const [validation, setValidation] = useState(null);
  const [sevFilter, setSevFilter] = useState("ALL");
  const [activeRule, setActiveRule] = useState(null);
  const [panelTab, setPanelTab] = useState("props");
  const [panelOpen, setPanelOpen] = useState(false);

  const runValidation = useCallback(
    (opts = {}) => {
      if (!wf || !graph) return null;
      if (!linter) {
        if (!opts.silent) notify("校验失败：工作流结构无法解析");
        return null;
      }
      try {
        // 规则结果：直接用 conductor-validate 的公开 API
        const findings = lintDefinition(wf)
          .map((f) => {
            // 「问题属于哪个任务」也由 conductor-validate 回答（Linter#nodeForPath）
            const linterNode = linter.nodeForPath(f.path);
            const graphNode = linterNode
              ? graph.byTask.get(linterNode.task) ||
                (linterNode.ref ? graph.nodes.get(linterNode.ref) : null) ||
                null
              : null;
            return {
              ...f,
              description: RULES_BY_ID.get(f.rule)?.description || "",
              taskRef: linterNode?.ref || "",
              graphRef: graphNode?.ref || null,
            };
          })
          .sort(
            (a, b) =>
              SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
              a.rule.localeCompare(b.rule) ||
              a.path.localeCompare(b.path)
          );

        const counts = { CRITICAL: 0, WARN: 0, INFO: 0 };
        const issues = new Map();
        for (const f of findings) {
          counts[f.severity] = (counts[f.severity] || 0) + 1;
          if (!f.graphRef) continue;
          const prev = issues.get(f.graphRef);
          if (!prev) {
            issues.set(f.graphRef, { severity: f.severity, count: 1 });
          } else {
            prev.count += 1;
            if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[prev.severity]) {
              prev.severity = f.severity;
            }
          }
        }

        const result = { findings, counts, issues };
        setValidation(result);
        if (!opts.silent) {
          setPanelTab("report");
          setPanelOpen(true);
          notify(
            findings.length
              ? `校验完成：严重 ${counts.CRITICAL || 0} · 警告 ${counts.WARN || 0} · 提示 ${counts.INFO || 0}`
              : "校验完成：没有发现问题"
          );
        }
        return result;
      } catch (e) {
        if (!opts.silent) notify(`校验失败：${e.message}`);
        return null;
      }
    },
    [wf, graph, linter, notify]
  );

  // 换了工作流就静默重跑一次，任务列表上直接标出有问题的节点
  useEffect(() => {
    if (!wf || !graph) {
      setValidation(null);
      return;
    }
    runValidation({ silent: true });
  }, [wf, graph, runValidation]);

  const nodeFindings = useMemo(
    () => (validation?.findings || []).filter((f) => f.graphRef && f.graphRef === selectedRef),
    [validation, selectedRef]
  );

  const handleSelect = (ref) => {
    setSelectedRef(ref);
    setShowJson(false);
    setPanelTab("props");
    setPanelOpen(true);
  };

  const openReport = () => {
    setPanelTab("report");
    setPanelOpen(true);
  };

  const openRules = (ruleId) => {
    if (ruleId) setActiveRule(ruleId);
    setPanelTab("rules");
    setPanelOpen(true);
  };

  /** 从校验结果跳到出问题的节点：选中 + 把画布平移过去 + 高亮 */
  const locate = (ref) => {
    if (!ref) return;
    setSelectedRef(ref);
    // 面板展开会改变画布尺寸，等布局稳定后再平移
    requestAnimationFrame(() => requestAnimationFrame(() => focusRef(ref)));
  };

  const copyNode = (obj) => {
    const text = JSON.stringify(obj, null, 2);
    try {
      const p = navigator.clipboard?.writeText(text);
      if (!p) {
        notify("浏览器不允许写剪贴板，请手动选择复制");
        return;
      }
      p.then(
        () => notify("节点 JSON 已复制到剪贴板"),
        () => notify("复制失败，请手动选择复制")
      );
    } catch {
      notify("复制失败，请手动选择复制");
    }
  };

  return html`
    <div class="app">
      <${Toolbar}
        wf=${wf}
        graphHostRef=${graphHostRef}
        onNotify=${notify}
        onValidate=${() => runValidation()}
        onRules=${() => openRules()}
        validation=${validation}
        summary=${summary}
      />
      <div class="body">
        <aside class="sidebar">
          ${wf
            ? html`
                <${TaskList}
                  graph=${graph}
                  selectedRef=${selectedRef}
                  onSelect=${handleSelect}
                  issues=${validation?.issues}
                />
                <button class="btn ghost full" onClick=${() => setWf(null)}>换一个工作流</button>
              `
            : html`<${Loader} onLoad=${(d) => { setWf(d); setSelectedRef(null); }} onNotify=${notify} />`}
        </aside>

        <main class="main">
          ${wf
            ? html`
                <div class="main-toolbar">
                  <span class="pill">${graph.order.length - 2} nodes</span>
                  <span class="pill">${graph.edges.length} edges</span>
                  ${summary?.subWorkflows.length
                    ? html`<span class="pill">子工作流: ${summary.subWorkflows.join(", ")}</span>`
                    : null}
                  ${validation
                    ? html`
                        <button
                          class=${"pill clickable " +
                            (validation.counts.CRITICAL
                              ? "pill-bad"
                              : validation.counts.WARN
                                ? "pill-warn"
                                : validation.findings.length
                                  ? "pill-info"
                                  : "pill-good")}
                          onClick=${openReport}
                          title="查看校验结果"
                        >
                          ${validation.counts.CRITICAL
                            ? `校验: ${validation.counts.CRITICAL} 严重`
                            : validation.counts.WARN
                              ? `校验: ${validation.counts.WARN} 警告`
                              : validation.findings.length
                                ? `校验: ${validation.findings.length} 提示`
                                : "校验: 通过"}
                          ${validation.counts.CRITICAL && validation.counts.WARN
                            ? ` · ${validation.counts.WARN} 警告`
                            : ""}
                        </button>
                      `
                    : html`<span class="pill muted">未校验</span>`}
                  <div class="spacer"></div>
                  <span class="hint">拖动画布平移 · 滚轮缩放</span>
                  <button class="btn small" onClick=${() => zoom(0.85)} title="缩小">−</button>
                  <span class="pill zoom-pill">${Math.round(scale * 100)}%</span>
                  <button class="btn small" onClick=${() => zoom(1.18)} title="放大">+</button>
                  <button class="btn small" onClick=${() => fit()} title="适应视图（重置平移）">适</button>
                  <button class=${"btn small" + (showJson ? " active" : "")} onClick=${() => setShowJson(!showJson)}>
                    原始 JSON
                  </button>
                </div>
                <div class="stage">
                  <div class=${"graph-host" + (dragging ? " dragging" : "")} ref=${setGraphHost}>
                    <div class="graph-viewport" ref=${viewportRef}>
                      <${WorkflowVisualizerJson}
                        data=${wf}
                        executionMode=${false}
                        onClick=${(e, data) => data?.id && handleSelect(data.id)}
                        handleLayoutChange=${onLayoutChange}
                      />
                    </div>
                  </div>
                  ${showJson
                    ? html`<pre class="json-pane">${JSON.stringify(wf, null, 2)}</pre>`
                    : null}
                </div>
              `
            : html`
                <div class="empty">
                  <div class="empty-art">◈</div>
                  <h2>没有加载工作流</h2>
                  <p>从左侧拖入 JSON 文件，或点击右上角选择。</p>
                </div>
              `}
        </main>

        ${panelOpen
          ? html`
              <aside class="inspector">
                <div class="panel-tabs">
                  <button
                    class=${"tab" + (panelTab === "props" ? " active" : "")}
                    onClick=${() => setPanelTab("props")}
                  >
                    属性
                  </button>
                  <button
                    class=${"tab" + (panelTab === "report" ? " active" : "")}
                    onClick=${() => setPanelTab("report")}
                  >
                    校验
                    ${validation && validation.findings.length
                      ? html`<span class="tab-badge">${validation.findings.length}</span>`
                      : null}
                  </button>
                  <button
                    class=${"tab" + (panelTab === "rules" ? " active" : "")}
                    onClick=${() => setPanelTab("rules")}
                  >
                    规则
                  </button>
                  <button class="tab-close" onClick=${() => setPanelOpen(false)} title="关闭面板">
                    ×
                  </button>
                </div>
                ${panelTab === "props"
                  ? html`
                      ${selectedNode
                        ? html`<${TaskDetails}
                            node=${selectedNode}
                            findings=${nodeFindings}
                            onCopy=${copyNode}
                          />`
                        : html`<${WorkflowDetails} wf=${wf} />`}
                    `
                  : null}
                ${panelTab === "report"
                  ? html`<${ValidationPanel}
                      result=${validation}
                      filter=${sevFilter}
                      onFilter=${setSevFilter}
                      onLocate=${locate}
                      onRerun=${() => runValidation()}
                      onOpenRule=${openRules}
                    />`
                  : null}
                ${panelTab === "rules"
                  ? html`<${RuleBook}
                      findings=${validation?.findings}
                      activeRule=${activeRule}
                      onPickRule=${setActiveRule}
                    />`
                  : null}
              </aside>
            `
          : null}
      </div>
      ${notice ? html`<div class="toast">${notice}</div>` : null}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
