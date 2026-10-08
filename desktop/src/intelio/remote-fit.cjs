'use strict';

/**
 * Fit a remote framebuffer inside the computer pane.
 * Scale down so both width and height fit, keep the aspect, and center it.
 * Never crop, and never grow the pane to the framebuffer.
 */
function containRemote(containerW, containerH, frameW, frameH) {
  const cw = Number(containerW);
  const ch = Number(containerH);
  const fw = Number(frameW);
  const fh = Number(frameH);
  if (!(cw > 0 && ch > 0 && fw > 0 && fh > 0)) {
    return { scale: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  const scale = Math.min(cw / fw, ch / fh);
  const width = fw * scale;
  const height = fh * scale;
  return { scale, width, height, x: (cw - width) / 2, y: (ch - height) / 2 };
}

/**
 * The computer tab at a window size. The address bar is hidden on that tab.
 * Widths match the desktop shell: sidebar 232, chat 490, splitter 5, pane pad 24.
 */
function computerScreen({ width, height, chat = 490, toolbar = false } = {}) {
  const sidebar = 232;
  const splitter = 5;
  const panePad = 24;
  const tabBar = 39;
  const footer = 31;
  const tool = toolbar ? 48 : 0;
  const head = 42;
  const hint = 25;
  const screenW = Number(width) - sidebar - chat - splitter - panePad;
  const screenH = Number(height) - tabBar - tool - footer - head - hint;
  return { screenW, screenH };
}

module.exports = { containRemote, computerScreen };
