<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { init, use } from "echarts/core";
import { LineChart } from "echarts/charts";
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ThemeId } from "./theme";

use([LineChart, AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type VmPoint = { vmId: string; vmName: string; usedBytes: number; capacityBytes: number; usageKnown: boolean };
type GrowthPoint = { at: string; reason: string; vms: VmPoint[] };
const props = defineProps<{ points: GrowthPoint[]; theme: ThemeId }>();

const chartElement = ref<HTMLElement>();
const summary = ref("Brak wystarczającej historii do obliczenia wzrostu.");
let chart: ReturnType<typeof init> | undefined;
let resizeObserver: ResizeObserver | undefined;
let zoomStart = 0;
let zoomEnd = 100;
const chartPalettes: Record<ThemeId, { colors: string[]; text: string; muted: string; grid: string; axis: string; tooltip: string; tooltipBorder: string; pointer: string; pointerLabel: string; zoom: string; zoomFill: string; zoomSelection: string }> = {
  "dark-blue": { colors: ["#44d7b6", "#f5b942", "#5cbdf5", "#a78bfa", "#ff7b72", "#f08bd4"], text: "#dce5f2", muted: "#aeb9c9", grid: "#182335", axis: "#77869c", tooltip: "#0b1320", tooltipBorder: "#2a394f", pointer: "#607086", pointerLabel: "#202c3f", zoom: "#0a111d", zoomFill: "rgba(68,215,182,.12)", zoomSelection: "#1a4b49" },
  "solarized-white": { colors: ["#268bd2", "#dc322f", "#2aa198", "#6c71c4", "#cb4b16", "#859900"], text: "#073642", muted: "#586e75", grid: "#d8d2bf", axis: "#657b83", tooltip: "#fdf6e3", tooltipBorder: "#b9c2b1", pointer: "#657b83", pointerLabel: "#eee8d5", zoom: "#eee8d5", zoomFill: "rgba(38,139,210,.16)", zoomSelection: "#c8d9d5" },
  "solarized-dark": { colors: ["#2aa198", "#b58900", "#268bd2", "#6c71c4", "#cb4b16", "#859900"], text: "#eee8d5", muted: "#93a1a1", grid: "#164b56", axis: "#93a1a1", tooltip: "#073642", tooltipBorder: "#28616b", pointer: "#839496", pointerLabel: "#0b4652", zoom: "#073642", zoomFill: "rgba(42,161,152,.18)", zoomSelection: "#12565d" },
  "retro-future": { colors: ["#ff4fd8", "#34e7ff", "#ffe66d", "#a78bfa", "#7cff6b", "#ff6b8a"], text: "#f4eaff", muted: "#c0afd9", grid: "#332450", axis: "#baa6db", tooltip: "#130d27", tooltipBorder: "#67458b", pointer: "#d087ff", pointerLabel: "#422260", zoom: "#100a20", zoomFill: "rgba(255,79,216,.18)", zoomSelection: "#482758" }
};

const formatBytes = (value: number, signed = false) => {
  const absolute = Math.abs(value);
  const divisor = absolute >= 1e12 ? 1e12 : 1e9;
  const unit = absolute >= 1e12 ? "TB" : "GB";
  const number = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(absolute / divisor);
  return `${signed ? (value >= 0 ? "+" : "−") : ""}${number} ${unit}`;
};
const formatDate = (value: string | number) => new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

function selectedPoints() {
  const ordered = [...props.points].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (ordered.length < 2) return ordered;
  let start = Math.floor((ordered.length - 1) * zoomStart / 100);
  let end = Math.ceil((ordered.length - 1) * zoomEnd / 100);
  if (end <= start) end = Math.min(ordered.length - 1, start + 1);
  if (end <= start) start = Math.max(0, end - 1);
  return ordered.slice(start, end + 1);
}

function topMachines(range: GrowthPoint[]) {
  const histories = new Map<string, { name: string; values: Array<{ at: number; usedBytes: number }> }>();
  for (const point of range) {
    const timestamp = new Date(point.at).getTime();
    for (const vm of point.vms || []) {
      if (!vm.usageKnown || !Number.isFinite(vm.usedBytes)) continue;
      const history = histories.get(vm.vmId) || { name: vm.vmName, values: [] };
      history.values.push({ at: timestamp, usedBytes: vm.usedBytes });
      histories.set(vm.vmId, history);
    }
  }
  return [...histories.entries()].map(([id, history]) => {
    const first = history.values[0];
    const last = history.values.at(-1)!;
    return {
      id,
      name: history.name,
      baselineAt: first.at,
      baselineUsedBytes: first.usedBytes,
      growth: history.values.length > 1 ? last.usedBytes - first.usedBytes : 0
    };
  }).filter((vm) => vm.growth > 0).sort((a, b) => b.growth - a.growth).slice(0, 6);
}

function render() {
  if (!chart || props.points.length < 2) {
    summary.value = "Potrzebne są co najmniej dwa snapshoty Storage Usage.";
    chart?.clear();
    return;
  }
  const allPoints = [...props.points].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const range = selectedPoints();
  const top = topMachines(range);
  const palette = chartPalettes[props.theme];
  const byTime = new Map(allPoints.map((point) => [new Date(point.at).getTime(), new Map((point.vms || []).map((vm) => [vm.vmId, vm]))]));
  const period = `${formatDate(range[0].at)} – ${formatDate(range.at(-1)!.at)}`;
  summary.value = top.length
    ? `${period}. Największe przyrosty: ${top.map((vm) => `${vm.name} ${formatBytes(vm.growth, true)}`).join(", ")}.`
    : `${period}. Brak dodatniego przyrostu dla maszyn z co najmniej dwoma znanymi snapshotami.`;

  chart.setOption({
    animation: !matchMedia("(prefers-reduced-motion: reduce)").matches,
    color: palette.colors,
    aria: { enabled: true, description: summary.value },
    grid: { left: 78, right: 28, top: 88, bottom: 88 },
    legend: { type: "scroll", top: 15, left: 18, right: 18, textStyle: { color: palette.muted, fontSize: 12 }, pageTextStyle: { color: palette.axis }, pageIconColor: palette.colors[0], pageIconInactiveColor: palette.axis },
    tooltip: {
      trigger: "axis", backgroundColor: palette.tooltip, borderColor: palette.tooltipBorder, textStyle: { color: palette.text },
      axisPointer: { type: "cross", lineStyle: { color: palette.pointer, type: "dashed" }, label: { backgroundColor: palette.pointerLabel, color: palette.text } },
      formatter: (items: any) => {
        const rows = Array.isArray(items) ? items : [items];
        if (!rows.length) return "";
        return `<strong>${formatDate(rows[0].value[0])}</strong><br/>${rows.map((item: any) => `${item.marker}${String(item.seriesName).split(" · ")[0]}: <b>${formatBytes(item.value[1], true)}</b>`).join("<br/>")}`;
      }
    },
    xAxis: { type: "time", boundaryGap: false, axisLine: { lineStyle: { color: palette.grid } }, axisTick: { show: false }, axisLabel: { color: palette.axis, hideOverlap: true }, splitLine: { show: false } },
    yAxis: { type: "value", name: "Przyrost netto od początku zakresu", nameTextStyle: { color: palette.axis, padding: [0, 0, 8, 0] }, axisLabel: { color: palette.axis, formatter: (value: number) => formatBytes(value, true) }, splitLine: { lineStyle: { color: palette.grid } } },
    dataZoom: [
      { type: "inside", start: zoomStart, end: zoomEnd, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
      { type: "slider", start: zoomStart, end: zoomEnd, height: 24, bottom: 25, borderColor: palette.grid, backgroundColor: palette.zoom, fillerColor: palette.zoomFill, dataBackground: { lineStyle: { color: palette.axis }, areaStyle: { color: palette.grid } }, selectedDataBackground: { lineStyle: { color: palette.colors[0] }, areaStyle: { color: palette.zoomSelection } }, handleStyle: { color: palette.colors[0], borderColor: palette.colors[0] }, textStyle: { color: palette.axis } }
    ],
    series: top.map((vm, index) => ({
      id: vm.id,
      name: `${vm.name} · ${formatBytes(vm.growth, true)}`,
      type: "line",
      showSymbol: false,
      connectNulls: false,
      smooth: 0.18,
      lineStyle: { width: 2, color: palette.colors[index] },
      itemStyle: { color: palette.colors[index] },
      emphasis: { focus: "series", lineStyle: { width: 3 } },
      data: allPoints.map((point) => {
        const timestamp = new Date(point.at).getTime();
        const value = byTime.get(timestamp)?.get(vm.id);
        const inRange = timestamp >= new Date(range[0].at).getTime() && timestamp <= new Date(range.at(-1)!.at).getTime();
        const hasUsage = value?.usageKnown && Number.isFinite(value.usedBytes);
        return [timestamp, inRange && timestamp >= vm.baselineAt && hasUsage ? value.usedBytes - vm.baselineUsedBytes : null];
      })
    }))
  }, { notMerge: true, lazyUpdate: true });
}

onMounted(async () => {
  await nextTick();
  if (!chartElement.value) return;
  chart = init(chartElement.value, undefined, { renderer: "canvas" });
  chart.on("datazoom", (event: any) => {
    const change = event.batch?.[0] || event;
    zoomStart = Number(change.start ?? zoomStart);
    zoomEnd = Number(change.end ?? zoomEnd);
    render();
  });
  resizeObserver = new ResizeObserver(() => chart?.resize());
  resizeObserver.observe(chartElement.value);
  render();
});
watch(() => [props.points, props.theme], () => render(), { deep: true });
onBeforeUnmount(() => { resizeObserver?.disconnect(); chart?.dispose(); });
</script>

<template>
  <div class="growth-chart-wrap">
    <div v-if="points.length < 2" class="growth-empty">Historia wzrostu pojawi się po zapisaniu co najmniej dwóch snapshotów.</div>
    <div v-show="points.length >= 2" ref="chartElement" class="growth-chart" role="img" :aria-label="summary"></div>
    <p class="growth-summary" aria-live="polite">{{ summary }}</p>
  </div>
</template>
