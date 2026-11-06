/**
 * dsh-lan-sync browser half.
 *
 * Settings page (Settings → 局域网同步), optional main panel + sidebar icon.
 * Talks to the Host half through same-origin `/api/lan-sync/*` routes with bare
 * fetch (the browser attaches the HttpOnly cookie; no auth headers are added).
 *
 * No build step: React.createElement only. `@deepseek-ai/dsh-client-ui-primitives`
 * is optional — Button/Switch fall back to native elements when unavailable.
 */

window.__ModuleLoader__.load({
  id: 'dsh-lan-sync',
  factory: (require) => {
    var module = { exports: {} };

    const React = require('react');
    const h = React.createElement;

    const NS = 'lan-sync';
    const API_BASE = '/api/lan-sync';
    const POLL_INTERVAL_MS = 3000;
    const GROUP_ID_LENGTH = 16;
    const MIN_GROUP_ID_LENGTH = 8;
    const DEFAULT_PEER_PORT = '56701';
    const GROUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const MAX_DIFF_CELLS = 400000;
    const MAX_DIFF_LINES = 2500;
    const MAX_SNAPSHOTS = 12;

    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      primitives = null;
    }
    const PrimitiveButton = primitives && primitives.Button ? primitives.Button : null;
    const PrimitiveSwitch = primitives && primitives.Switch ? primitives.Switch : null;

    // Set by apply(); read by Page so the settings page can jump to the panel.
    let mainPanelRegistered = false;

    const DIRECTION_OPTIONS = [
      ['both', 'dirBoth'],
      ['push', 'dirPush'],
      ['pull', 'dirPull'],
      ['paused', 'dirPaused'],
    ];

    const ERROR_KEYS = {
      'group-id-too-short': 'errGroupShort',
      'address-must-be-url': 'errAddress',
      'no-group': 'errNoGroup',
      'unknown-peer': 'errUnknownPeer',
      'not-found': 'errConflictGone',
      'missing-item': 'errMissingItem',
      'missing-blob': 'errMissingBlob',
      'invalid-json': 'errInvalidJson',
      'unsupported-action': 'errUnsupported',
      'bad-direction': 'errBadDirection',
      internal: 'errInternal',
    };

    const CSS = `
.ls-root{display:flex;flex-direction:column;gap:16px;padding:2px 0 12px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;min-width:0}
.ls-root *{box-sizing:border-box}
.ls-root-panel{max-width:1040px;margin:0 auto;padding:24px 24px 36px;width:100%}
.ls-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ls-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.35}
.ls-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px;max-width:720px}
.ls-banner{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.ls-banner-ok{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-bg,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-success-primary)}
.ls-banner-error{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-bg,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-error-primary)}
.ls-banner-info{color:var(--dsw-alias-label-secondary)}
.ls-banner-text{flex:1;min-width:0;overflow-wrap:anywhere;word-break:break-word}
.ls-banner-close{appearance:none;flex:none;border:0;background:transparent;color:inherit;font:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7;padding:0 2px}
.ls-banner-close:hover{opacity:1}
.ls-statusbar{display:flex;flex-wrap:wrap;gap:6px 18px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.ls-stat{display:flex;align-items:baseline;gap:6px;font-size:12px;min-width:0}
.ls-stat-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ls-stat-value{color:var(--dsw-alias-label-primary);font-weight:500;overflow-wrap:anywhere;word-break:break-word}
.ls-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.ls-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ls-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ls-card-desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.ls-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ls-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ls-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;overflow-wrap:anywhere}
.ls-hint-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.ls-hint-ok{color:var(--dsw-alias-state-success-primary)}
.ls-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:4px;white-space:nowrap;max-width:100%}
.ls-badge-info{border-color:var(--dsw-alias-state-brand-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-brand-primary,var(--dsw-alias-label-secondary))}
.ls-badge-warn{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));background:var(--dsw-alias-state-warning-bg,var(--dsw-alias-bg-layer-2))}
.ls-badge-muted{opacity:.85}
.ls-mono,.ls-group-id,.ls-conflict-key,.ls-snap-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.ls-input,.ls-select,.ls-textarea{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:32px;padding:0 10px;outline:none;min-width:0}
.ls-input::placeholder,.ls-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.ls-input:focus,.ls-select:focus,.ls-textarea:focus{border-color:var(--dsw-alias-state-brand-primary,var(--dsw-alias-label-primary))}
.ls-input-grow{flex:1 1 260px;min-width:0}
.ls-textarea{height:auto;min-height:200px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;line-height:1.55;resize:vertical;white-space:pre;overflow:auto}
.ls-select{cursor:pointer;padding-right:6px}
.ls-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .15s ease,border-color .15s ease,opacity .15s ease;white-space:nowrap}
.ls-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-4,var(--dsw-alias-bg-layer-2)))}
.ls-btn:disabled{opacity:.45;cursor:not-allowed}
.ls-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
.ls-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ls-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ls-btn-sm{padding:3px 9px;font-size:11px}
.ls-group-display{display:flex;flex-direction:column;gap:8px;min-width:0}
.ls-group-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ls-group-id{font-size:13px;letter-spacing:.5px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;word-break:break-all}
.ls-group-editor{display:flex;flex-direction:column;gap:6px;min-width:0}
.ls-peers{display:flex;flex-direction:column;gap:8px}
.ls-peer{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));min-width:0}
.ls-peer-main{display:flex;flex-direction:column;gap:3px;flex:1 1 260px;min-width:0}
.ls-peer-name{font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere;word-break:break-word}
.ls-peer-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;word-break:break-word}
.ls-peer-side{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:0 1 230px;min-width:0}
.ls-peer-field{display:flex;align-items:center;gap:6px}
.ls-peer-error{color:var(--dsw-alias-state-error-primary);font-size:11px;overflow-wrap:anywhere;word-break:break-word;max-width:100%}
.ls-empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ls-conflicts{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:12px;align-items:start;min-width:0}
.ls-conflict-list{display:flex;flex-direction:column;gap:4px;max-height:460px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));min-width:0}
.ls-conflict-item{appearance:none;text-align:left;font:inherit;cursor:pointer;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:7px 9px;display:flex;flex-direction:column;gap:3px;width:100%;min-width:0}
.ls-conflict-item:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.ls-conflict-item-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.ls-conflict-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ls-conflict-key{font-size:11px;overflow-wrap:anywhere;word-break:break-word}
.ls-detail{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));min-width:0}
.ls-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0}
.ls-detail-title{font-size:12px;font-weight:600;min-width:0;overflow-wrap:anywhere;word-break:break-word}
.ls-diff-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;min-width:0}
.ls-diff-col{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;min-width:0}
.ls-diff-head{padding:6px 10px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:space-between;gap:8px;overflow-wrap:anywhere;word-break:break-word}
.ls-diff-body{max-height:360px;overflow:auto;padding:4px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:11.5px;line-height:1.55}
.ls-line{display:flex;gap:6px;padding:0 8px;white-space:pre;min-width:max-content;color:var(--dsw-alias-label-primary)}
.ls-line-sign{flex:none;width:10px;color:var(--dsw-alias-label-tertiary);user-select:none;text-align:center}
.ls-line-add{background:var(--dsw-alias-state-success-bg,rgba(46,160,67,.12));color:var(--dsw-alias-state-success-primary)}
.ls-line-del{background:var(--dsw-alias-state-error-bg,rgba(248,81,73,.12));color:var(--dsw-alias-state-error-primary);opacity:.9}
.ls-editor{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;min-width:0}
.ls-snaps{display:flex;flex-direction:column;gap:6px}
.ls-snap{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2));min-width:0}
.ls-snap-id{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ls-snap-keys{flex:1 1 160px;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls-setting{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:8px 0}
.ls-setting + .ls-setting{border-top:1px solid var(--dsw-alias-border-l2)}
.ls-setting-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}
.ls-check{display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none;padding-top:2px}
.ls-check input{width:16px;height:16px;accent-color:var(--dsw-alias-label-primary);cursor:pointer}
@media (max-width:820px){.ls-conflicts{grid-template-columns:1fr}.ls-diff-grid{grid-template-columns:1fr}.ls-peer-side{align-items:flex-start;flex-basis:100%}.ls-root-panel{padding:18px 14px 28px}}
`;

    let stylesInjected = false;

    function ensureStyles() {
      if (stylesInjected) return;
      if (typeof document === 'undefined' || !document.head) return;
      try {
        if (typeof document.querySelector === 'function' && document.querySelector('style[data-dsh-plugin="lan-sync"]')) {
          stylesInjected = true;
          return;
        }
        if (typeof document.getElementById === 'function' && document.getElementById('dsh-lan-sync-css')) {
          stylesInjected = true;
          return;
        }
        const tag = document.createElement('style');
        tag.id = 'dsh-lan-sync-css';
        tag.setAttribute('data-dsh-plugin', 'lan-sync');
        tag.textContent = CSS;
        document.head.appendChild(tag);
        stylesInjected = true;
      } catch (error) {
        /* styling must never break the page */
      }
    }

    // The style tag is injected from the factory (once) as required; apply() calls
    // ensureStyles again in case the factory ran before document.head existed.
    ensureStyles();

    const zh = {
      pageTitle: '局域网同步',
      pageSubtitle: '在多台设备之间同步配置、插件与 Skills；冲突需要你手动裁决。',
      loading: '加载中…',
      retry: '重试',
      loadFailed: '无法连接同步服务',
      pollFailed: '轮询失败，正在重试',
      pollFailedHint: '请确认 Host 半已加载且服务正在运行。',
      dismiss: '关闭提示',
      backToChat: '返回对话',
      openPanel: '打开同步面板',
      statusNode: '本机',
      statusPlatform: '平台',
      statusPort: '端口',
      statusPeers: '在线设备',
      statusConflicts: '未解决冲突',
      statusItems: '同步条目',
      portOff: '未启用',
      groupTitle: '同步组',
      groupDescEmpty: '创建一个 16 位组 ID，然后在其他设备上启用同一个组 ID。',
      groupDescSet: '组 ID 是加入该组的唯一凭据，请只在本机之间传递。',
      groupIdLabel: '组 ID',
      groupIdPlaceholder: '输入或随机生成 16 位组 ID',
      groupRandom: '随机生成',
      groupEnable: '启用',
      groupEnableBusy: '正在启用…',
      groupChange: '更换组',
      groupCancel: '取消',
      groupShow: '显示',
      groupHide: '隐藏',
      groupTag: '组标记',
      groupCreated: '创建于',
      groupChangeHint: '更换组后，其他设备需要重新加入。',
      groupServerOff: '同步服务未启动，端口可能被占用。',
      groupEnabled: '同步组已启用',
      copy: '复制',
      copied: '组 ID 已复制',
      copyFailed: '复制失败，请手动选择文本',
      errGroupShort: '组 ID 至少需要 8 个字符',
      syncTitle: '同步',
      syncDesc: '立即与在线设备交换本机变更。',
      syncNow: '立即同步',
      syncBusy: '正在同步…',
      syncDone: '同步完成',
      syncPartial: '同步完成，{n} 台设备失败',
      joinLabel: '手动加入设备',
      joinPlaceholder: '例如 192.168.1.8:56701',
      join: '加入',
      joinBusy: '正在加入…',
      joinDone: '已加入该设备',
      joinNeedsGroup: '请先启用同步组，再加入其他设备。',
      addressAutoHint: '可只填 IP 或 IP:端口，默认端口 56701。',
      peersTitle: '设备',
      peersDesc: '已发现或手动加入的设备。',
      peersEmpty: '还没有设备。启用同步组后会自动发现同一局域网内的设备。',
      peersCount: '{n} 台',
      peerSameHost: '同一台机器',
      peerDirection: '同步方向',
      peerLastSync: '最后同步',
      peerNever: '从未',
      peerError: '错误',
      peerNoName: '未命名设备',
      dirBoth: '双向',
      dirPush: '只推送',
      dirPull: '只拉取',
      dirPaused: '暂停',
      directionSaved: '同步方向已更新',
      conflictsTitle: '冲突',
      conflictsDesc: '同一字段在两端被修改，需要你选择保留哪一边。',
      conflictsEmpty: '没有待处理的冲突。',
      conflictSelect: '从左侧选择一条冲突查看差异。',
      conflictNoDiff: '无法显示差异（内容不可用或已被删除）。',
      conflictPaths: '涉及字段',
      conflictCreated: '创建于',
      conflictOurs: '本机',
      conflictTheirs: '对方',
      conflictKeepOurs: '保留本机',
      conflictTakeTheirs: '采用对方',
      conflictBoth: '两边都要（合并）',
      conflictPin: '本机锁定',
      conflictEdit: '手动编辑',
      conflictEditHint: '内容必须是 JSON 对象；提交后会作为本机版本写入并同步。',
      conflictMergeHintJson: '已自动合并双方 JSON，请检查后提交。',
      conflictMergeHintRaw: '无法自动合并，请手动把对方改动补进下方 JSON。',
      conflictSubmitEdit: '提交编辑',
      conflictCancelEdit: '取消',
      conflictResolved: '冲突已解决',
      conflictPinDone: '已在本机锁定该条目',
      conflictTooLarge: '差异过大，已截断',
      kindConfig: '配置',
      kindSkill: 'Skill',
      kindDep: '依赖',
      kindBundles: '插件集',
      kindProfileFile: 'Profile 文件',
      kindUnknown: '未知',
      reasonNoCommonBase: '无共同基线',
      reasonDeleteVsModify: '删除/修改',
      reasonDiverged: '内容分叉',
      snapshotsTitle: '快照',
      snapshotsDesc: '每次应用远端变更前保存的本机状态。',
      snapshotsEmpty: '暂无快照。',
      snapshotRollback: '回滚',
      snapshotConfirm: '确认回滚',
      snapshotCancel: '取消',
      snapshotRollingBack: '正在回滚…',
      snapshotDone: '已回滚到该快照',
      snapshotEntries: '{n} 项',
      snapshotLoadFail: '快照加载失败：{msg}',
      snapshotMore: '仅显示最近 {n} 个快照',
      settingsTitle: '设置',
      settingsDesc: '控制同步的自动化程度。',
      autoApply: '自动应用远端变更',
      autoApplyHint: '无冲突时直接写入本机文件。',
      autoInstallPlugins: '自动安装插件',
      autoInstallHint: '同步时自动安装新增的插件依赖。',
      settingsSaved: '设置已保存',
      errAddress: '地址无效，请填写 IP 或 IP:端口',
      errNoGroup: '尚未启用同步组',
      errUnknownPeer: '设备不存在，请刷新后重试',
      errConflictGone: '冲突已不存在，可能已被解决',
      errMissingItem: '本机缺少对应条目，无法裁决',
      errMissingBlob: '内容缺失，无法应用该操作',
      errInvalidJson: '内容不是合法的 JSON',
      errUnsupported: '不支持的操作',
      errBadDirection: '同步方向无效',
      errInternal: 'Host 内部错误',
      errUnknown: '未知错误',
      errNetwork: '无法连接 Host，请检查服务是否运行',
      errHttp: '请求失败（HTTP {status}）',
      errEditObject: '内容必须是 JSON 对象',
    };

    const en = {
      pageTitle: 'LAN Sync',
      pageSubtitle: 'Sync config, plugins and Skills across your devices; conflicts need manual review.',
      loading: 'Loading…',
      retry: 'Retry',
      loadFailed: 'Cannot reach the sync service',
      pollFailed: 'Polling failed, retrying',
      pollFailedHint: 'Make sure the Host half is loaded and running.',
      dismiss: 'Dismiss',
      backToChat: 'Back to chat',
      openPanel: 'Open sync panel',
      statusNode: 'Node',
      statusPlatform: 'Platform',
      statusPort: 'Port',
      statusPeers: 'Devices',
      statusConflicts: 'Open conflicts',
      statusItems: 'Items',
      portOff: 'off',
      groupTitle: 'Sync group',
      groupDescEmpty: 'Create a 16-character group ID, then enable the same ID on your other devices.',
      groupDescSet: 'The group ID is the only credential for this group. Keep it between your own machines.',
      groupIdLabel: 'Group ID',
      groupIdPlaceholder: 'Enter or generate a 16-character group ID',
      groupRandom: 'Generate',
      groupEnable: 'Enable',
      groupEnableBusy: 'Enabling…',
      groupChange: 'Change group',
      groupCancel: 'Cancel',
      groupShow: 'Show',
      groupHide: 'Hide',
      groupTag: 'Tag',
      groupCreated: 'Created',
      groupChangeHint: 'After changing the group, other devices must join again.',
      groupServerOff: 'The sync server is not running; the port may be in use.',
      groupEnabled: 'Sync group enabled',
      copy: 'Copy',
      copied: 'Group ID copied',
      copyFailed: 'Copy failed; select the text manually',
      errGroupShort: 'The group ID needs at least 8 characters',
      syncTitle: 'Sync',
      syncDesc: 'Exchange local changes with online devices now.',
      syncNow: 'Sync now',
      syncBusy: 'Syncing…',
      syncDone: 'Sync finished',
      syncPartial: 'Sync finished, {n} device(s) failed',
      joinLabel: 'Join a device manually',
      joinPlaceholder: 'e.g. 192.168.1.8:56701',
      join: 'Join',
      joinBusy: 'Joining…',
      joinDone: 'Device joined',
      joinNeedsGroup: 'Enable a sync group before joining other devices.',
      addressAutoHint: 'An IP or IP:port works; the default port is 56701.',
      peersTitle: 'Devices',
      peersDesc: 'Discovered or manually joined devices.',
      peersEmpty: 'No devices yet. Enable a sync group to discover devices on the same LAN.',
      peersCount: '{n} device(s)',
      peerSameHost: 'Same machine',
      peerDirection: 'Direction',
      peerLastSync: 'Last sync',
      peerNever: 'Never',
      peerError: 'Error',
      peerNoName: 'Unnamed device',
      dirBoth: 'Both',
      dirPush: 'Push only',
      dirPull: 'Pull only',
      dirPaused: 'Paused',
      directionSaved: 'Direction updated',
      conflictsTitle: 'Conflicts',
      conflictsDesc: 'The same field changed on both sides; choose which side to keep.',
      conflictsEmpty: 'No open conflicts.',
      conflictSelect: 'Select a conflict on the left to inspect the diff.',
      conflictNoDiff: 'Diff unavailable (content missing or deleted).',
      conflictPaths: 'Fields',
      conflictCreated: 'Created',
      conflictOurs: 'Ours',
      conflictTheirs: 'Theirs',
      conflictKeepOurs: 'Keep ours',
      conflictTakeTheirs: 'Take theirs',
      conflictBoth: 'Keep both (merge)',
      conflictPin: 'Pin on this node',
      conflictEdit: 'Edit manually',
      conflictEditHint: 'Content must be a JSON object; it is written and synced as this node’s version.',
      conflictMergeHintJson: 'Both JSON sides were merged automatically; review before submitting.',
      conflictMergeHintRaw: 'Automatic merge failed; add the other side’s changes to the JSON below.',
      conflictSubmitEdit: 'Submit',
      conflictCancelEdit: 'Cancel',
      conflictResolved: 'Conflict resolved',
      conflictPinDone: 'Item pinned on this node',
      conflictTooLarge: 'Diff too large; truncated',
      kindConfig: 'Config',
      kindSkill: 'Skill',
      kindDep: 'Dependency',
      kindBundles: 'Bundles',
      kindProfileFile: 'Profile file',
      kindUnknown: 'Unknown',
      reasonNoCommonBase: 'No common base',
      reasonDeleteVsModify: 'Delete vs modify',
      reasonDiverged: 'Diverged',
      snapshotsTitle: 'Snapshots',
      snapshotsDesc: 'Local state saved before each remote apply.',
      snapshotsEmpty: 'No snapshots yet.',
      snapshotRollback: 'Roll back',
      snapshotConfirm: 'Confirm',
      snapshotCancel: 'Cancel',
      snapshotRollingBack: 'Rolling back…',
      snapshotDone: 'Rolled back to this snapshot',
      snapshotEntries: '{n} item(s)',
      snapshotLoadFail: 'Failed to load snapshots: {msg}',
      snapshotMore: 'Showing the latest {n} snapshots',
      settingsTitle: 'Settings',
      settingsDesc: 'Control how automatic sync is.',
      autoApply: 'Apply remote changes automatically',
      autoApplyHint: 'Write local files directly when there is no conflict.',
      autoInstallPlugins: 'Install plugins automatically',
      autoInstallHint: 'Install newly synced plugin dependencies.',
      settingsSaved: 'Settings saved',
      errAddress: 'Invalid address; use an IP or IP:port',
      errNoGroup: 'No sync group yet',
      errUnknownPeer: 'Unknown device; refresh and try again',
      errConflictGone: 'This conflict no longer exists',
      errMissingItem: 'The local item is missing, so it cannot be resolved here',
      errMissingBlob: 'Content missing; cannot apply this action',
      errInvalidJson: 'Content is not valid JSON',
      errUnsupported: 'Unsupported action',
      errBadDirection: 'Invalid sync direction',
      errInternal: 'Host internal error',
      errUnknown: 'Unknown error',
      errNetwork: 'Cannot reach the Host; check that the service is running',
      errHttp: 'Request failed (HTTP {status})',
      errEditObject: 'Content must be a JSON object',
    };

    function translate(lang, key, params) {
      const chinese = String(lang || '').toLowerCase().startsWith('zh');
      const dict = chinese ? zh : en;
      let text = dict[key];
      if (text === undefined) text = en[key];
      if (text === undefined) text = key;
      if (params && typeof text === 'string') {
        text = text.replace(/\{(\w+)\}/g, (match, name) => {
          const value = params[name];
          return value === undefined || value === null ? match : String(value);
        });
      }
      return text;
    }

    function errorText(code, t) {
      const value = code === undefined || code === null ? '' : String(code);
      const key = ERROR_KEYS[value];
      if (key) return t(key);
      if (/^HTTP \d+$/.test(value)) return t('errHttp', { status: value.slice(5) });
      if (/failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(value)) return t('errNetwork');
      return value || t('errUnknown');
    }

    function noticeText(notice, t) {
      if (!notice) return '';
      if (notice.key) return t(notice.key, notice.params);
      if (notice.errorCode !== undefined) return errorText(notice.errorCode, t);
      return notice.raw ? String(notice.raw) : '';
    }

    function activeLocale(ctx) {
      try {
        if (ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function') {
          const snapshot = ctx.locale.getSnapshot();
          if (snapshot && typeof snapshot.active === 'string' && snapshot.active) return snapshot.active;
        }
      } catch (error) {
        /* fall through to navigator */
      }
      try {
        if (typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string' && navigator.language) {
          return navigator.language;
        }
      } catch (error) {
        /* ignore */
      }
      return 'en';
    }

    function useLocale(ctx) {
      const [lang, setLang] = React.useState(() => activeLocale(ctx));
      React.useEffect(() => {
        setLang(activeLocale(ctx));
        let off = null;
        try {
          if (ctx && ctx.locale && typeof ctx.locale.subscribe === 'function') {
            off = ctx.locale.subscribe(() => setLang(activeLocale(ctx)));
          }
        } catch (error) {
          off = null;
        }
        return () => {
          if (typeof off === 'function') {
            try {
              off();
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, [ctx]);
      return lang;
    }

    function formatTime(value, lang) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      try {
        const chinese = String(lang || '').toLowerCase().startsWith('zh');
        return date.toLocaleString(chinese ? 'zh-CN' : 'en-US', { hour12: false });
      } catch (error) {
        return date.toISOString();
      }
    }

    function randomGroupId(length) {
      let out = '';
      try {
        const cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
        if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
          const bytes = new Uint8Array(length);
          cryptoObject.getRandomValues(bytes);
          for (let index = 0; index < length; index += 1) {
            out += GROUP_ALPHABET[bytes[index] % GROUP_ALPHABET.length];
          }
          return out;
        }
      } catch (error) {
        /* fall back to Math.random */
      }
      for (let index = 0; index < length; index += 1) {
        out += GROUP_ALPHABET[Math.floor(Math.random() * GROUP_ALPHABET.length)];
      }
      return out;
    }

    function maskGroupId(id) {
      const value = String(id || '');
      if (value.length <= 4) return '••••';
      return value.slice(0, 4) + '•'.repeat(Math.min(12, value.length - 4));
    }

    function normalizeAddress(input) {
      const raw = String(input || '').trim();
      if (!raw) return '';
      const withScheme = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
      try {
        const parsed = new URL(withScheme);
        if (!parsed.hostname) return '';
        if (!parsed.port) parsed.port = DEFAULT_PEER_PORT;
        return parsed.origin;
      } catch (error) {
        return '';
      }
    }

    async function api(path, init) {
      const options = {
        credentials: 'same-origin',
        cache: 'no-store',
        method: 'GET',
        headers: { accept: 'application/json' },
      };
      if (init && init.method) options.method = init.method;
      if (init && init.signal) options.signal = init.signal;
      if (init && init.body !== undefined) {
        options.method = options.method === 'GET' ? 'POST' : options.method;
        options.headers = { accept: 'application/json', 'content-type': 'application/json' };
        options.body = JSON.stringify(init.body);
      }
      const response = await fetch(API_BASE + path, options);
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          data = null;
        }
      }
      if (!response.ok) {
        const code = data && data.error ? String(data.error) : 'HTTP ' + response.status;
        const failure = new Error(code);
        failure.status = response.status;
        throw failure;
      }
      if (data && data.ok === false) throw new Error(String(data.error || 'failed'));
      return data || {};
    }

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function safeStringify(value) {
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    }

    function mergeJsonValues(ours, theirs) {
      if (Array.isArray(ours) && Array.isArray(theirs)) {
        const out = ours.slice();
        const seen = new Set(out.map((item) => safeStringify(item)));
        for (const item of theirs) {
          const marker = safeStringify(item);
          if (!seen.has(marker)) {
            seen.add(marker);
            out.push(item);
          }
        }
        return out;
      }
      if (isPlainObject(ours) && isPlainObject(theirs)) {
        const out = {};
        for (const key of Object.keys(ours)) out[key] = ours[key];
        for (const key of Object.keys(theirs)) {
          out[key] = Object.prototype.hasOwnProperty.call(ours, key) ? mergeJsonValues(ours[key], theirs[key]) : theirs[key];
        }
        return out;
      }
      // Conflicting scalar: keep ours. The result is shown in the editor for review.
      return ours;
    }

    function buildMergeSeed(conflict) {
      const diff = conflict && conflict.diff ? conflict.diff : null;
      const oursLines = diff && Array.isArray(diff.ours) ? diff.ours : null;
      const theirsLines = diff && Array.isArray(diff.theirs) ? diff.theirs : null;
      if (!oursLines) return { text: theirsLines ? theirsLines.join('\n') : '', mode: 'raw' };
      const oursText = oursLines.join('\n');
      if (!theirsLines) return { text: oursText, mode: 'raw' };
      try {
        const oursValue = JSON.parse(oursText);
        const theirsValue = JSON.parse(theirsLines.join('\n'));
        if (isPlainObject(oursValue) && isPlainObject(theirsValue)) {
          return { text: JSON.stringify(mergeJsonValues(oursValue, theirsValue), null, 2) + '\n', mode: 'json' };
        }
      } catch (error) {
        /* not JSON: fall back to ours-only seed */
      }
      return { text: oursText, mode: 'raw' };
    }

    function buildDiffRows(base, side) {
      if (!Array.isArray(side)) return { rows: [], truncated: false };
      const plain = side.map((text) => ({ type: 'same', text: String(text) }));
      if (!Array.isArray(base) || base.length === 0) {
        return { rows: plain.slice(0, MAX_DIFF_LINES), truncated: plain.length > MAX_DIFF_LINES };
      }
      const n = base.length;
      const m = side.length;
      if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
        return { rows: plain.slice(0, MAX_DIFF_LINES), truncated: m > MAX_DIFF_LINES || n > 0 };
      }
      const width = m + 1;
      const dp = new Uint32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i * width + j] =
            base[i] === side[j]
              ? dp[(i + 1) * width + j + 1] + 1
              : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
        }
      }
      const rows = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (base[i] === side[j]) {
          rows.push({ type: 'same', text: String(side[j]) });
          i += 1;
          j += 1;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
          rows.push({ type: 'del', text: String(base[i]) });
          i += 1;
        } else {
          rows.push({ type: 'add', text: String(side[j]) });
          j += 1;
        }
      }
      while (i < n) {
        rows.push({ type: 'del', text: String(base[i]) });
        i += 1;
      }
      while (j < m) {
        rows.push({ type: 'add', text: String(side[j]) });
        j += 1;
      }
      const truncated = rows.length > MAX_DIFF_LINES;
      return { rows: truncated ? rows.slice(0, MAX_DIFF_LINES) : rows, truncated };
    }

    function kindLabel(kind, t) {
      switch (kind) {
        case 'config':
          return t('kindConfig');
        case 'skill':
          return t('kindSkill');
        case 'dep':
          return t('kindDep');
        case 'bundles':
          return t('kindBundles');
        case 'profile-file':
          return t('kindProfileFile');
        default:
          return kind ? String(kind) : t('kindUnknown');
      }
    }

    function reasonLabel(reason, t) {
      switch (reason) {
        case 'no-common-base':
          return t('reasonNoCommonBase');
        case 'delete-vs-modify':
          return t('reasonDeleteVsModify');
        case 'diverged':
          return t('reasonDiverged');
        default:
          return reason ? String(reason) : '';
      }
    }

    function Btn(props) {
      const kind = props.kind;
      const disabled = Boolean(props.disabled);
      const onClick = props.onClick;
      const title = props.title;
      const children = props.children;
      if (PrimitiveButton) {
        return h(
          PrimitiveButton,
          {
            variant: kind === 'primary' ? 'primary' : kind === 'ghost' ? 'ghost' : 'outline',
            size: 'sm',
            disabled: disabled,
            onClick: onClick,
            title: title,
            type: props.type || 'button',
          },
          children,
        );
      }
      let className = 'ls-btn';
      if (kind === 'primary') className += ' ls-btn-primary';
      else if (kind === 'danger') className += ' ls-btn-danger';
      else if (kind === 'ghost') className += ' ls-btn-ghost';
      if (props.size === 'sm') className += ' ls-btn-sm';
      return h(
        'button',
        {
          type: props.type || 'button',
          className: className,
          disabled: disabled,
          onClick: onClick,
          title: title,
        },
        children,
      );
    }

    function Toggle(props) {
      const label = props.label;
      if (PrimitiveSwitch) {
        return h(PrimitiveSwitch, {
          checked: Boolean(props.checked),
          disabled: Boolean(props.disabled),
          label: label,
          onChange: props.onChange,
        });
      }
      return h(
        'label',
        { className: 'ls-check', title: label },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          disabled: Boolean(props.disabled),
          'aria-label': label,
          onChange: (event) => props.onChange(event.target.checked),
        }),
      );
    }

    function Stat(props) {
      return h(
        'div',
        { className: 'ls-stat', title: props.title || undefined },
        h('span', { className: 'ls-stat-label' }, props.label),
        h('span', { className: 'ls-stat-value' }, props.value),
      );
    }

    function DiffColumn(props) {
      const t = props.t;
      const side = props.side;
      const available = Array.isArray(side);
      const computed = React.useMemo(() => buildDiffRows(props.base, side), [props.base, side]);
      const rows = computed.rows;
      return h(
        'div',
        { className: 'ls-diff-col' },
        h(
          'div',
          { className: 'ls-diff-head' },
          h('span', null, props.title),
          computed.truncated ? h('span', { className: 'ls-badge ls-badge-warn' }, t('conflictTooLarge')) : null,
        ),
        available
          ? h(
              'div',
              { className: 'ls-diff-body', role: 'region', 'aria-label': props.title },
              rows.length === 0
                ? h('div', { className: 'ls-empty' }, '∅')
                : rows.map((row, index) => {
                    let className = 'ls-line';
                    let sign = ' ';
                    if (row.type === 'add') {
                      className += ' ls-line-add';
                      sign = '+';
                    } else if (row.type === 'del') {
                      className += ' ls-line-del';
                      sign = '−';
                    }
                    return h(
                      'div',
                      { className: className, key: index },
                      h('span', { className: 'ls-line-sign' }, sign),
                      h('span', null, row.text === '' ? '\u00a0' : row.text),
                    );
                  }),
            )
          : h('div', { className: 'ls-empty' }, t('conflictNoDiff')),
      );
    }

    function SidebarIcon(props) {
      const size = Number(props && props.size) || 16;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: active ? 1 : 0.82 },
        },
        h('rect', { x: 3, y: 5, width: 7, height: 6, rx: 1.5 }),
        h('rect', { x: 14, y: 13, width: 7, height: 6, rx: 1.5 }),
        h('path', { d: 'M10 8h4a2 2 0 0 1 2 2v3' }),
        h('circle', { cx: 12, cy: 12, r: 1.1, fill: 'currentColor', stroke: 'none' }),
      );
    }

    function Page(props) {
      const ctx = props && props.ctx;
      const panelMode = Boolean(props && props.panelMode);
      const lang = useLocale(ctx);
      const t = (key, params) => translate(lang, key, params);

      const [status, setStatus] = React.useState(null);
      const [conflicts, setConflicts] = React.useState([]);
      const [snapshots, setSnapshots] = React.useState([]);
      const [snapError, setSnapError] = React.useState('');
      const [snapLoading, setSnapLoading] = React.useState(true);
      const [snapVersion, setSnapVersion] = React.useState(0);
      const [notice, setNotice] = React.useState(null);
      const [pollError, setPollError] = React.useState('');
      const [busy, setBusy] = React.useState({});
      const [groupId, setGroupId] = React.useState('');
      const [changingGroup, setChangingGroup] = React.useState(false);
      const [showGroupId, setShowGroupId] = React.useState(false);
      const [joinAddr, setJoinAddr] = React.useState('');
      const [selectedId, setSelectedId] = React.useState(null);
      const [editing, setEditing] = React.useState(false);
      const [editContent, setEditContent] = React.useState('');
      const [editMode, setEditMode] = React.useState(null);
      const [editError, setEditError] = React.useState(null);
      const [confirmRollback, setConfirmRollback] = React.useState(null);

      const aliveRef = React.useRef(true);
      const abortRef = React.useRef(null);
      const busyRef = React.useRef(new Set());
      const seededRef = React.useRef(false);

      const notify = React.useCallback((next) => setNotice(next), []);
      const notifyError = React.useCallback((error) => {
        const message = error && error.message !== undefined ? error.message : error;
        setNotice({ kind: 'error', errorCode: message === undefined || message === null ? '' : String(message) });
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          if (abortRef.current && typeof abortRef.current.abort === 'function') abortRef.current.abort();
        } catch (error) {
          /* ignore */
        }
        let controller = null;
        try {
          if (typeof AbortController !== 'undefined') controller = new AbortController();
        } catch (error) {
          controller = null;
        }
        abortRef.current = controller;
        const signal = controller ? controller.signal : undefined;
        try {
          const results = await Promise.all([api('/status', { signal }), api('/conflicts', { signal })]);
          if (!aliveRef.current || (controller && controller.signal.aborted)) return;
          const nextStatus = results[0];
          const nextConflicts = results[1];
          setStatus(nextStatus && typeof nextStatus === 'object' ? nextStatus : null);
          setConflicts(nextConflicts && Array.isArray(nextConflicts.conflicts) ? nextConflicts.conflicts : []);
          setPollError('');
        } catch (error) {
          if (!aliveRef.current || (controller && controller.signal.aborted)) return;
          if (error && error.name === 'AbortError') return;
          const message = error && error.message !== undefined ? error.message : error;
          setPollError(String(message === undefined || message === null ? 'failed' : message));
        }
      }, []);

      const run = React.useCallback(
        async (key, task) => {
          if (busyRef.current.has(key)) return false;
          busyRef.current.add(key);
          setBusy((previous) => {
            const next = Object.assign({}, previous);
            next[key] = true;
            return next;
          });
          try {
            await task();
            return true;
          } catch (error) {
            if (aliveRef.current) notifyError(error);
            return false;
          } finally {
            busyRef.current.delete(key);
            if (aliveRef.current) {
              setBusy((previous) => {
                if (!previous[key]) return previous;
                const next = Object.assign({}, previous);
                delete next[key];
                return next;
              });
            }
          }
        },
        [notifyError],
      );

      React.useEffect(() => {
        aliveRef.current = true;
        refresh();
        const timer = setInterval(() => {
          if (!aliveRef.current) return;
          refresh();
        }, POLL_INTERVAL_MS);
        return () => {
          aliveRef.current = false;
          clearInterval(timer);
          try {
            if (abortRef.current && typeof abortRef.current.abort === 'function') abortRef.current.abort();
          } catch (error) {
            /* ignore */
          }
        };
      }, [refresh]);

      React.useEffect(() => {
        let cancelled = false;
        setSnapLoading(true);
        setSnapError('');
        api('/snapshots')
          .then((data) => {
            if (cancelled) return;
            setSnapshots(data && Array.isArray(data.snapshots) ? data.snapshots : []);
            setSnapLoading(false);
          })
          .catch((error) => {
            if (cancelled) return;
            const message = error && error.message !== undefined ? error.message : error;
            setSnapError(String(message === undefined || message === null ? 'failed' : message));
            setSnapLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [snapVersion]);

      React.useEffect(() => {
        if (!status || seededRef.current) return;
        seededRef.current = true;
        if (!status.group) setGroupId(randomGroupId(GROUP_ID_LENGTH));
      }, [status]);

      React.useEffect(() => {
        if (!selectedId) return;
        const present = conflicts.some((item) => item && item.id === selectedId);
        if (!present) {
          setSelectedId(null);
          setEditing(false);
          setEditContent('');
          setEditError(null);
          setEditMode(null);
        }
      }, [conflicts, selectedId]);

      React.useEffect(() => {
        if (!confirmRollback) return undefined;
        const timer = setTimeout(() => setConfirmRollback(null), 6000);
        return () => clearTimeout(timer);
      }, [confirmRollback]);

      React.useEffect(() => {
        if (!notice || notice.kind === 'error') return undefined;
        const timer = setTimeout(() => setNotice(null), 5000);
        return () => clearTimeout(timer);
      }, [notice]);

      const isBusy = (key) => Boolean(busy[key]);
      const identity = status && status.identity ? status.identity : null;
      const group = status && status.group ? status.group : null;
      const peers = status && Array.isArray(status.peers) ? status.peers : [];
      const settings = status && status.settings ? status.settings : {};
      const conflictCount = status && typeof status.conflicts === 'number' ? status.conflicts : conflicts.length;
      const canOpenPanel = !panelMode && mainPanelRegistered && Boolean(ctx && ctx.layout && typeof ctx.layout.selectPanel === 'function');

      async function enableGroup() {
        const id = String(groupId || '').trim();
        if (id.length < MIN_GROUP_ID_LENGTH) {
          notify({ kind: 'error', key: 'errGroupShort' });
          return;
        }
        await run('group', async () => {
          await api('/group', { body: { id } });
          setChangingGroup(false);
          setShowGroupId(false);
          setSnapVersion((value) => value + 1);
          await refresh();
          notify({ kind: 'ok', key: 'groupEnabled' });
        });
      }

      async function copyGroupId() {
        const id = status && status.group ? String(status.group.id || '') : '';
        if (!id) return;
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('clipboard-unavailable');
          }
          await navigator.clipboard.writeText(id);
          notify({ kind: 'ok', key: 'copied' });
        } catch (error) {
          notify({ kind: 'error', key: 'copyFailed' });
        }
      }

      async function syncNow() {
        await run('sync', async () => {
          const data = await api('/sync', { method: 'POST' });
          const failed = data && Array.isArray(data.results) ? data.results.filter((item) => item && item.error).length : 0;
          await refresh();
          setSnapVersion((value) => value + 1);
          if (failed > 0) notify({ kind: 'error', key: 'syncPartial', params: { n: failed } });
          else notify({ kind: 'ok', key: 'syncDone' });
        });
      }

      async function joinPeer() {
        const address = normalizeAddress(joinAddr);
        if (!address) {
          notify({ kind: 'error', key: 'errAddress' });
          return;
        }
        await run('join', async () => {
          await api('/join', { body: { address } });
          setJoinAddr('');
          await refresh();
          notify({ kind: 'ok', key: 'joinDone' });
        });
      }

      async function changeDirection(peer, direction) {
        if (!peer || !peer.nodeId) return;
        setStatus((previous) => {
          if (!previous || !Array.isArray(previous.peers)) return previous;
          return Object.assign({}, previous, {
            peers: previous.peers.map((item) => (item && item.nodeId === peer.nodeId ? Object.assign({}, item, { direction }) : item)),
          });
        });
        const ok = await run('direction:' + peer.nodeId, async () => {
          await api('/peers/' + encodeURIComponent(peer.nodeId) + '/direction', { body: { direction } });
          notify({ kind: 'ok', key: 'directionSaved' });
        });
        if (!ok) refresh();
      }

      function selectConflict(id) {
        setSelectedId(id);
        setEditing(false);
        setEditContent('');
        setEditMode(null);
        setEditError(null);
      }

      async function resolveConflictAction(conflict, action) {
        if (!conflict) return;
        await run('conflict', async () => {
          await api('/conflicts/' + encodeURIComponent(conflict.id) + '/resolve', { body: { action } });
          setEditing(false);
          setEditContent('');
          setEditMode(null);
          setEditError(null);
          await refresh();
          notify({ kind: 'ok', key: action === 'pin' ? 'conflictPinDone' : 'conflictResolved' });
        });
      }

      function openEditor(conflict, merge) {
        if (!conflict) return;
        const diff = conflict.diff || {};
        const seed = merge ? buildMergeSeed(conflict) : { text: Array.isArray(diff.ours) ? diff.ours.join('\n') : '', mode: 'manual' };
        setEditing(true);
        setEditMode(seed.mode);
        setEditContent(seed.text);
        setEditError(null);
      }

      async function submitEdit(conflict) {
        if (!conflict) return;
        const text = editContent;
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          setEditError('errInvalidJson');
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setEditError('errEditObject');
          return;
        }
        setEditError(null);
        await run('conflict', async () => {
          await api('/conflicts/' + encodeURIComponent(conflict.id) + '/resolve', { body: { action: 'edit', content: text } });
          setEditing(false);
          setEditContent('');
          setEditMode(null);
          await refresh();
          notify({ kind: 'ok', key: 'conflictResolved' });
        });
      }

      async function rollbackSnapshot(id) {
        await run('rollback:' + id, async () => {
          await api('/snapshots/' + encodeURIComponent(id) + '/rollback', { method: 'POST' });
          setConfirmRollback(null);
          setSnapVersion((value) => value + 1);
          await refresh();
          notify({ kind: 'ok', key: 'snapshotDone' });
        });
      }

      async function updateSettings(patch) {
        setStatus((previous) => {
          if (!previous) return previous;
          return Object.assign({}, previous, { settings: Object.assign({}, previous.settings || {}, patch) });
        });
        const ok = await run('settings', async () => {
          await api('/settings', { body: patch });
          notify({ kind: 'ok', key: 'settingsSaved' });
        });
        if (!ok) refresh();
      }

      function openPanel() {
        try {
          if (!canOpenPanel) return;
          ctx.layout.selectPanel('lan-sync');
          if (props && typeof props.close === 'function') {
            try {
              props.close();
            } catch (error) {
              /* settings close is optional */
            }
          }
        } catch (error) {
          notifyError(error);
        }
      }

      function backToConversation() {
        try {
          if (ctx && ctx.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(null);
        } catch (error) {
          notifyError(error);
        }
      }

      function deployedLabel(nodeId) {
        if (!nodeId) return '';
        if (identity && identity.nodeId === nodeId) return identity.name || t('statusNode');
        const peer = peers.find((item) => item && item.nodeId === nodeId);
        return peer && peer.name ? peer.name : String(nodeId);
      }

      const noticeBar = notice
        ? h(
            'div',
            {
              className: 'ls-banner ls-banner-' + (notice.kind === 'ok' ? 'ok' : notice.kind === 'error' ? 'error' : 'info'),
              role: notice.kind === 'error' ? 'alert' : 'status',
            },
            h('span', { className: 'ls-banner-text' }, noticeText(notice, t)),
            h(
              'button',
              { type: 'button', className: 'ls-banner-close', onClick: () => setNotice(null), 'aria-label': t('dismiss') },
              '×',
            ),
          )
        : null;

      const header = h(
        'div',
        { className: 'ls-header' },
        h(
          'div',
          null,
          h('div', { className: 'ls-title' }, t('pageTitle')),
          h('div', { className: 'ls-sub' }, t('pageSubtitle')),
        ),
        h(
          'div',
          { className: 'ls-actions' },
          pollError && status
            ? h('span', { className: 'ls-badge ls-badge-warn', title: errorText(pollError, t) }, t('pollFailed'))
            : null,
          panelMode
            ? h(Btn, { kind: 'ghost', onClick: backToConversation }, t('backToChat'))
            : canOpenPanel
              ? h(Btn, { onClick: openPanel }, t('openPanel'))
              : null,
        ),
      );

      let body;
      if (!status) {
        body = h(
          'section',
          { className: 'ls-card' },
          h('div', { className: 'ls-empty' }, pollError ? t('loadFailed') : t('loading')),
          pollError ? h('div', { className: 'ls-hint', style: { textAlign: 'center' } }, errorText(pollError, t)) : null,
          pollError
            ? h(
                'div',
                { className: 'ls-actions', style: { justifyContent: 'center' } },
                h(Btn, { onClick: () => refresh() }, t('retry')),
              )
            : null,
        );
      } else {
        const identityName = identity && identity.name ? String(identity.name) : '—';
        const platform = identity && identity.platform ? String(identity.platform) : '—';
        const port = identity && identity.port ? String(identity.port) : t('portOff');

        const statusBar = h(
          'div',
          { className: 'ls-statusbar' },
          h(Stat, { label: t('statusNode'), value: identityName, title: identityName }),
          h(Stat, { label: t('statusPlatform'), value: platform }),
          h(Stat, { label: t('statusPort'), value: port }),
          h(Stat, { label: t('statusPeers'), value: String(peers.length) }),
          h(Stat, { label: t('statusConflicts'), value: String(conflictCount) }),
          h(Stat, { label: t('statusItems'), value: status && typeof status.items === 'number' ? String(status.items) : '—' }),
        );

        const groupEditor = h(
          'div',
          { className: 'ls-group-editor' },
          h(
            'div',
            { className: 'ls-inline' },
            h('input', {
              className: 'ls-input ls-input-grow',
              value: groupId,
              placeholder: t('groupIdPlaceholder'),
              maxLength: 64,
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': t('groupIdLabel'),
              onChange: (event) => setGroupId(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  enableGroup();
                }
              },
            }),
            h(Btn, { onClick: () => setGroupId(randomGroupId(GROUP_ID_LENGTH)) }, t('groupRandom')),
            h(
              Btn,
              {
                kind: 'primary',
                disabled: isBusy('group') || String(groupId || '').trim().length < MIN_GROUP_ID_LENGTH,
                onClick: enableGroup,
                title: String(groupId || '').trim().length < MIN_GROUP_ID_LENGTH ? t('errGroupShort') : undefined,
              },
              isBusy('group') ? t('groupEnableBusy') : t('groupEnable'),
            ),
            changingGroup && group ? h(Btn, { onClick: () => { setChangingGroup(false); setGroupId(''); } }, t('groupCancel')) : null,
          ),
          String(groupId || '').trim().length > 0 && String(groupId || '').trim().length < MIN_GROUP_ID_LENGTH
            ? h('div', { className: 'ls-hint ls-hint-warn' }, t('errGroupShort'))
            : null,
          group ? h('div', { className: 'ls-hint' }, t('groupChangeHint')) : null,
        );

        const groupDisplay = group
          ? h(
              'div',
              { className: 'ls-group-display' },
              h(
                'div',
                { className: 'ls-group-line' },
                h('span', { className: 'ls-hint' }, t('groupIdLabel')),
                h('code', { className: 'ls-group-id' }, showGroupId ? group.id : maskGroupId(group.id)),
                h(Btn, { size: 'sm', onClick: () => setShowGroupId((value) => !value) }, showGroupId ? t('groupHide') : t('groupShow')),
                h(Btn, { size: 'sm', onClick: copyGroupId }, t('copy')),
              ),
              h(
                'div',
                { className: 'ls-group-line' },
                h('span', { className: 'ls-badge' }, t('groupTag') + ' ' + (group.tag || '—')),
                group.createdAt ? h('span', { className: 'ls-hint' }, t('groupCreated') + ' ' + formatTime(group.createdAt, lang)) : null,
                identity && !identity.port ? h('span', { className: 'ls-badge ls-badge-warn' }, t('groupServerOff')) : null,
              ),
            )
          : null;

        const groupCard = h(
          'section',
          { className: 'ls-card' },
          h(
            'div',
            { className: 'ls-card-head' },
            h(
              'div',
              null,
              h('div', { className: 'ls-card-title' }, t('groupTitle')),
              h('div', { className: 'ls-card-desc' }, group && !changingGroup ? t('groupDescSet') : t('groupDescEmpty')),
            ),
            group && !changingGroup
              ? h(Btn, { onClick: () => { setChangingGroup(true); setGroupId(''); setShowGroupId(false); } }, t('groupChange'))
              : null,
          ),
          group && !changingGroup ? groupDisplay : groupEditor,
        );

        const syncCard = h(
          'section',
          { className: 'ls-card' },
          h(
            'div',
            { className: 'ls-card-head' },
            h(
              'div',
              null,
              h('div', { className: 'ls-card-title' }, t('syncTitle')),
              h('div', { className: 'ls-card-desc' }, t('syncDesc')),
            ),
            h(
              Btn,
              { kind: 'primary', disabled: isBusy('sync'), onClick: syncNow },
              isBusy('sync') ? t('syncBusy') : t('syncNow'),
            ),
          ),
          h(
            'div',
            { className: 'ls-group-editor' },
            h('div', { className: 'ls-hint' }, t('joinLabel')),
            h(
              'div',
              { className: 'ls-inline' },
              h('input', {
                className: 'ls-input ls-input-grow',
                value: joinAddr,
                placeholder: t('joinPlaceholder'),
                maxLength: 200,
                spellCheck: false,
                autoComplete: 'off',
                'aria-label': t('joinLabel'),
                onChange: (event) => setJoinAddr(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    joinPeer();
                  }
                },
              }),
              h(
                Btn,
                {
                  disabled: isBusy('join') || !group || !String(joinAddr || '').trim(),
                  onClick: joinPeer,
                  title: !group ? t('joinNeedsGroup') : undefined,
                },
                isBusy('join') ? t('joinBusy') : t('join'),
              ),
            ),
            h('div', { className: 'ls-hint' }, t('addressAutoHint')),
            !group ? h('div', { className: 'ls-hint ls-hint-warn' }, t('joinNeedsGroup')) : null,
          ),
        );

        const peersCard = h(
          'section',
          { className: 'ls-card' },
          h(
            'div',
            { className: 'ls-card-head' },
            h(
              'div',
              null,
              h('div', { className: 'ls-card-title' }, t('peersTitle')),
              h('div', { className: 'ls-card-desc' }, t('peersDesc')),
            ),
            h('span', { className: 'ls-badge' }, t('peersCount', { n: peers.length })),
          ),
          peers.length === 0
            ? h('div', { className: 'ls-empty' }, t('peersEmpty'))
            : h(
                'div',
                { className: 'ls-peers' },
                peers.map((peer) => {
                  const peerName = peer && (peer.name || peer.nodeId) ? peer.name || peer.nodeId : t('peerNoName');
                  const direction = peer && peer.direction ? peer.direction : 'both';
                  return h(
                    'div',
                    { className: 'ls-peer', key: peer && peer.nodeId ? peer.nodeId : peerName },
                    h(
                      'div',
                      { className: 'ls-peer-main' },
                      h(
                        'div',
                        { className: 'ls-peer-name' },
                        h('span', null, peerName),
                        peer && peer.platform ? h('span', { className: 'ls-badge' }, String(peer.platform)) : null,
                        peer && peer.sameHost ? h('span', { className: 'ls-badge ls-badge-info' }, t('peerSameHost')) : null,
                      ),
                      h('div', { className: 'ls-peer-meta' }, peer && peer.baseUrl ? String(peer.baseUrl) : '—'),
                    ),
                    h(
                      'div',
                      { className: 'ls-peer-side' },
                      h(
                        'label',
                        { className: 'ls-peer-field' },
                        h('span', { className: 'ls-hint' }, t('peerDirection')),
                        h(
                          'select',
                          {
                            className: 'ls-select',
                            value: direction,
                            disabled: isBusy('direction:' + (peer && peer.nodeId ? peer.nodeId : '')),
                            'aria-label': t('peerDirection'),
                            onChange: (event) => changeDirection(peer, event.target.value),
                          },
                          DIRECTION_OPTIONS.map((option) => h('option', { key: option[0], value: option[0] }, t(option[1]))),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ls-peer-meta' },
                        t('peerLastSync') + ' ' + (peer && peer.lastSyncAt ? formatTime(peer.lastSyncAt, lang) : t('peerNever')),
                      ),
                      peer && peer.lastError
                        ? h('div', { className: 'ls-peer-error', title: String(peer.lastError) }, t('peerError') + ': ' + String(peer.lastError))
                        : null,
                    ),
                  );
                }),
              ),
        );

        const selectedConflict = selectedId ? conflicts.find((item) => item && item.id === selectedId) : null;
        let detail = h('div', { className: 'ls-empty' }, t('conflictSelect'));
        if (selectedConflict) {
          const diff = selectedConflict.diff || null;
          const oursLabel = deployedLabel(selectedConflict.oursBy);
          const theirsLabel = deployedLabel(selectedConflict.theirsBy);
          const canKeepBoth =
            selectedConflict.kind === 'config' &&
            diff &&
            Array.isArray(diff.ours) &&
            Array.isArray(diff.theirs);

          detail = h(
            'div',
            { className: 'ls-detail' },
            h(
              'div',
              { className: 'ls-detail-head' },
              h('div', { className: 'ls-detail-title' }, h('span', { className: 'ls-mono' }, String(selectedConflict.key || ''))),
              h(
                'div',
                { className: 'ls-inline' },
                h('span', { className: 'ls-badge' }, kindLabel(selectedConflict.kind, t)),
                selectedConflict.reason
                  ? h('span', { className: 'ls-badge ls-badge-muted' }, reasonLabel(selectedConflict.reason, t))
                  : null,
                h(
                  'span',
                  { className: 'ls-hint' },
                  t('conflictCreated') + ' ' + formatTime(selectedConflict.createdAt, lang),
                ),
              ),
            ),
            h(
              'div',
              { className: 'ls-hint' },
              t('conflictOurs') + ': ' + (oursLabel || '—') + '  ·  ' + t('conflictTheirs') + ': ' + (theirsLabel || '—'),
            ),
            selectedConflict.paths && selectedConflict.paths.length
              ? h(
                  'div',
                  { className: 'ls-hint' },
                  t('conflictPaths') + ': ' + selectedConflict.paths.map((path) => String(path)).join(', '),
                )
              : null,
            h(
              'div',
              { className: 'ls-diff-grid' },
              h(DiffColumn, {
                title: t('conflictOurs') + (oursLabel ? ' · ' + oursLabel : ''),
                base: diff ? diff.base : null,
                side: diff ? diff.ours : null,
                t,
              }),
              h(DiffColumn, {
                title: t('conflictTheirs') + (theirsLabel ? ' · ' + theirsLabel : ''),
                base: diff ? diff.base : null,
                side: diff ? diff.theirs : null,
                t,
              }),
            ),
            h(
              'div',
              { className: 'ls-actions' },
              h(
                Btn,
                { kind: 'primary', disabled: isBusy('conflict'), onClick: () => resolveConflictAction(selectedConflict, 'ours') },
                t('conflictKeepOurs'),
              ),
              h(
                Btn,
                { disabled: isBusy('conflict'), onClick: () => resolveConflictAction(selectedConflict, 'theirs') },
                t('conflictTakeTheirs'),
              ),
              canKeepBoth
                ? h(
                    Btn,
                    { disabled: isBusy('conflict'), onClick: () => openEditor(selectedConflict, true), title: t('conflictMergeHintJson') },
                    t('conflictBoth'),
                  )
                : null,
              h(
                Btn,
                { disabled: isBusy('conflict'), onClick: () => resolveConflictAction(selectedConflict, 'pin') },
                t('conflictPin'),
              ),
              h(
                Btn,
                { disabled: isBusy('conflict'), onClick: () => openEditor(selectedConflict, false) },
                t('conflictEdit'),
              ),
            ),
            editing
              ? h(
                  'div',
                  { className: 'ls-editor' },
                  h('div', { className: 'ls-hint' }, t('conflictEditHint')),
                  editMode === 'json'
                    ? h('div', { className: 'ls-hint ls-hint-ok' }, t('conflictMergeHintJson'))
                    : editMode === 'raw'
                      ? h('div', { className: 'ls-hint ls-hint-warn' }, t('conflictMergeHintRaw'))
                      : null,
                  h('textarea', {
                    className: 'ls-textarea',
                    value: editContent,
                    spellCheck: false,
                    'aria-label': t('conflictEdit'),
                    onChange: (event) => setEditContent(event.target.value),
                  }),
                  editError ? h('div', { className: 'ls-peer-error' }, t(editError)) : null,
                  h(
                    'div',
                    { className: 'ls-actions' },
                    h(
                      Btn,
                      { kind: 'primary', disabled: isBusy('conflict'), onClick: () => submitEdit(selectedConflict) },
                      t('conflictSubmitEdit'),
                    ),
                    h(
                      Btn,
                      {
                        disabled: isBusy('conflict'),
                        onClick: () => {
                          setEditing(false);
                          setEditContent('');
                          setEditError(null);
                        },
                      },
                      t('conflictCancelEdit'),
                    ),
                  ),
                )
              : null,
          );
        }

        const conflictsCard = h(
          'section',
          { className: 'ls-card' },
          h(
            'div',
            { className: 'ls-card-head' },
            h(
              'div',
              null,
              h('div', { className: 'ls-card-title' }, t('conflictsTitle')),
              h('div', { className: 'ls-card-desc' }, t('conflictsDesc')),
            ),
            h('span', { className: 'ls-badge' }, String(conflicts.length)),
          ),
          conflicts.length === 0
            ? h('div', { className: 'ls-empty' }, t('conflictsEmpty'))
            : h(
                'div',
                { className: 'ls-conflicts' },
                h(
                  'div',
                  { className: 'ls-conflict-list', role: 'list' },
                  conflicts.map((conflict) =>
                    h(
                      'button',
                      {
                        key: conflict && conflict.id ? conflict.id : String(conflict && conflict.key),
                        type: 'button',
                        className:
                          'ls-conflict-item' + (selectedId && conflict && selectedId === conflict.id ? ' ls-conflict-item-active' : ''),
                        onClick: () => selectConflict(conflict && conflict.id ? conflict.id : null),
                      },
                      h(
                        'span',
                        { className: 'ls-conflict-top' },
                        h('span', { className: 'ls-badge' }, kindLabel(conflict && conflict.kind, t)),
                        conflict && conflict.reason
                          ? h('span', { className: 'ls-badge ls-badge-muted' }, reasonLabel(conflict.reason, t))
                          : null,
                      ),
                      h('span', { className: 'ls-conflict-key' }, conflict && conflict.key ? String(conflict.key) : ''),
                      h('span', { className: 'ls-hint' }, conflict ? formatTime(conflict.createdAt, lang) : ''),
                    ),
                  ),
                ),
                detail,
              ),
        );

        const snapshotBadge = h('span', { className: 'ls-badge' }, String(snapshots.length));
        const snapshotsCard = h(
          'section',
          { className: 'ls-card' },
          h(
            'div',
            { className: 'ls-card-head' },
            h(
              'div',
              null,
              h('div', { className: 'ls-card-title' }, t('snapshotsTitle')),
              h('div', { className: 'ls-card-desc' }, t('snapshotsDesc')),
            ),
            snapshotBadge,
          ),
          snapError
            ? h('div', { className: 'ls-peer-error' }, t('snapshotLoadFail', { msg: errorText(snapError, t) }))
            : null,
          snapLoading
            ? h('div', { className: 'ls-empty' }, t('loading'))
            : snapshots.length === 0
              ? h('div', { className: 'ls-empty' }, t('snapshotsEmpty'))
              : h(
                  'div',
                  { className: 'ls-snaps' },
                  snapshots.slice(0, MAX_SNAPSHOTS).map((snapshot) => {
                    if (!snapshot || !snapshot.id) return null;
                    const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
                    const keys = entries.map((entry) => (entry && entry.key ? String(entry.key) : '')).filter(Boolean);
                    const preview = keys.slice(0, 3).join(' · ') + (keys.length > 3 ? ' +' + (keys.length - 3) : '');
                    const confirming = confirmRollback === snapshot.id;
                    const busyRollback = isBusy('rollback:' + snapshot.id);
                    return h(
                      'div',
                      { className: 'ls-snap', key: snapshot.id },
                      h('span', { className: 'ls-snap-id', title: String(snapshot.id) }, String(snapshot.id).slice(0, 10)),
                      h('span', { className: 'ls-hint' }, formatTime(snapshot.at, lang)),
                      h('span', { className: 'ls-badge' }, t('snapshotEntries', { n: entries.length })),
                      h('span', { className: 'ls-snap-keys', title: keys.join('\n') }, preview || '—'),
                      confirming
                        ? h(
                            'span',
                            { className: 'ls-inline' },
                            h(
                              Btn,
                              { kind: 'primary', disabled: busyRollback, onClick: () => rollbackSnapshot(snapshot.id) },
                              busyRollback ? t('snapshotRollingBack') : t('snapshotConfirm'),
                            ),
                            h(Btn, { disabled: busyRollback, onClick: () => setConfirmRollback(null) }, t('snapshotCancel')),
                          )
                        : h(
                            Btn,
                            { disabled: busyRollback, onClick: () => setConfirmRollback(snapshot.id) },
                            t('snapshotRollback'),
                          ),
                    );
                  }),
                ),
          snapshots.length > MAX_SNAPSHOTS
            ? h('div', { className: 'ls-hint' }, t('snapshotMore', { n: MAX_SNAPSHOTS }))
            : null,
        );

        const settingsCard = h(
          'section',
          { className: 'ls-card' },
          h(
            'div',
            { className: 'ls-card-head' },
            h(
              'div',
              null,
              h('div', { className: 'ls-card-title' }, t('settingsTitle')),
              h('div', { className: 'ls-card-desc' }, t('settingsDesc')),
            ),
          ),
          h(
            'div',
            { className: 'ls-setting' },
            h(
              'div',
              null,
              h('div', { className: 'ls-setting-label' }, t('autoApply')),
              h('div', { className: 'ls-hint' }, t('autoApplyHint')),
            ),
            h(Toggle, {
              checked: settings.autoApply !== false,
              disabled: isBusy('settings'),
              label: t('autoApply'),
              onChange: (next) => updateSettings({ autoApply: next }),
            }),
          ),
          h(
            'div',
            { className: 'ls-setting' },
            h(
              'div',
              null,
              h('div', { className: 'ls-setting-label' }, t('autoInstallPlugins')),
              h('div', { className: 'ls-hint' }, t('autoInstallHint')),
            ),
            h(Toggle, {
              checked: settings.autoInstallPlugins === true,
              disabled: isBusy('settings'),
              label: t('autoInstallPlugins'),
              onChange: (next) => updateSettings({ autoInstallPlugins: next }),
            }),
          ),
        );

        body = h(React.Fragment, null, statusBar, groupCard, syncCard, peersCard, conflictsCard, snapshotsCard, settingsCard);
      }

      return h('div', { className: 'ls-root' + (panelMode ? ' ls-root-panel' : '') }, noticeBar, header, body);
    }

    module.exports.inject = ['slots', 'locale'];
    module.exports.apply = function apply(ctx) {
      ensureStyles();
      if (!ctx) return;

      // Locale dictionaries: unregister on plugin unload when ctx.effect exists.
      let localeRegistered = false;
      const registerLocale = () => {
        if (localeRegistered) return () => {};
        try {
          if (!ctx.locale || typeof ctx.locale.register !== 'function') return () => {};
          const dispose = ctx.locale.register(NS, { zh, en });
          localeRegistered = true;
          return () => {
            if (typeof dispose === 'function') {
              try {
                dispose();
              } catch (error) {
                /* already removed */
              }
            }
          };
        } catch (error) {
          console.error('[lan-sync] locale.register failed', error);
          return () => {};
        }
      };
      if (typeof ctx.effect === 'function') {
        try {
          ctx.effect(registerLocale, 'lan-sync: locale dictionaries');
        } catch (error) {
          console.error('[lan-sync] locale effect failed', error);
          registerLocale();
        }
      } else {
        registerLocale();
      }

      if (!ctx.slots || typeof ctx.slots.register !== 'function') {
        console.error('[lan-sync] slots service unavailable; settings page not registered');
        return;
      }

      const navLabel = () => (activeLocale(ctx).toLowerCase().startsWith('zh') ? zh.pageTitle : en.pageTitle);

      const tryRegister = (options, component) => {
        try {
          const result = ctx.slots.register(options, component);
          return { ok: true, dispose: typeof result === 'function' ? result : null };
        } catch (error) {
          console.error('[lan-sync] slot registration failed: ' + options.name, error);
          return { ok: false, dispose: null };
        }
      };

      let sectionRegistered = false;
      let itemRegistered = false;
      let itemDispose = null;
      let fallbackTimer = null;

      const registerSection = () => {
        if (sectionRegistered) return;
        const result = tryRegister(
          {
            name: 'settings.section',
            id: 'lan-sync',
            order: 80,
            label: navLabel,
            locale: NS,
            inject: () => ({ ctx }),
          },
          Page,
        );
        if (!result.ok) return;
        sectionRegistered = true;
        if (itemDispose) {
          try {
            itemDispose();
          } catch (error) {
            /* item card already gone */
          }
          itemDispose = null;
          itemRegistered = false;
        }
      };

      const registerItemCard = () => {
        if (itemRegistered || sectionRegistered) return;
        const result = tryRegister(
          {
            name: 'plugins.item',
            id: 'lan-sync-card',
            order: 70,
            label: navLabel,
            locale: NS,
            inject: () => ({ ctx }),
          },
          Page,
        );
        if (!result.ok) return;
        itemRegistered = true;
        itemDispose = result.dispose;
      };

      if (typeof ctx.slots.inject === 'function') {
        try {
          ctx.slots.inject('settings.section', registerSection);
        } catch (error) {
          console.error('[lan-sync] slots.inject failed for settings.section', error);
          registerSection();
        }
        // Fallback seat: only when settings.section was never declared/served.
        fallbackTimer = setTimeout(() => {
          if (sectionRegistered) return;
          if (typeof ctx.slots.inject === 'function') {
            try {
              ctx.slots.inject('plugins.item', registerItemCard);
              return;
            } catch (error) {
              console.error('[lan-sync] slots.inject failed for plugins.item', error);
            }
          }
          registerItemCard();
        }, 2500);
      } else {
        registerSection();
        if (!sectionRegistered) registerItemCard();
      }

      if (fallbackTimer !== null && typeof ctx.effect === 'function') {
        try {
          ctx.effect(
            () => () => {
              if (fallbackTimer !== null) clearTimeout(fallbackTimer);
            },
            'lan-sync: settings seat fallback timer',
          );
        } catch (error) {
          /* timer is a one-shot harmless if the effect cannot be bound */
        }
      }

      // Optional main panel + sidebar icon. Failures here never affect the page.
      // The icon is only registered after the panel seat succeeds, so a sidebar
      // entry can never point at a panel that failed to register.
      let mainRegistered = false;
      let sidebarIconRegistered = false;
      const registerSidebarIcon = () => {
        if (sidebarIconRegistered) return;
        const result = tryRegister(
          {
            name: 'sidebar.panellist',
            id: 'lan-sync',
            order: 80,
            label: navLabel,
            locale: NS,
            inject: () => ({ ctx }),
          },
          SidebarIcon,
        );
        if (result.ok) sidebarIconRegistered = true;
      };
      const registerMainPanel = () => {
        if (mainRegistered) return;
        const result = tryRegister({ name: 'main', key: 'lan-sync', inject: () => ({ ctx, panelMode: true }) }, Page);
        if (!result.ok) return;
        mainRegistered = true;
        mainPanelRegistered = true;
        try {
          if (typeof ctx.slots.inject === 'function') ctx.slots.inject('sidebar.panellist', registerSidebarIcon);
          else registerSidebarIcon();
        } catch (error) {
          console.error('[lan-sync] slots.inject failed for sidebar.panellist', error);
          registerSidebarIcon();
        }
      };
      try {
        if (typeof ctx.slots.inject === 'function') ctx.slots.inject('main', registerMainPanel);
        else registerMainPanel();
      } catch (error) {
        console.error('[lan-sync] slots.inject failed for main', error);
        registerMainPanel();
      }
    };

    return module.exports;
  },
});
