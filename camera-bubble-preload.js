'use strict';

// Preload for the on-screen camera window (camera-bubble.html): reports drags.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleAPI', {
  // phase: 'start' | 'move' | 'end'; dx / dy: pointer travel since the start, in screen points
  drag: (phase, dx, dy) => ipcRenderer.send('camera-bubble:drag', { phase, dx, dy }),
});
