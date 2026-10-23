/** 文件说明：创建并导出应用使用的 Vuetify 实例、主题与字体图标配置。 */
import 'vuetify/styles';

import { VClassIcon } from 'vuetify/components';
import { createVuetify } from 'vuetify';

import { createVuetifyBootstrapThemes } from '@theme/adapters/vuetify';
import { DEFAULT_THEME_IDS } from '@theme/core/resolver';

const aliases = {
  collapse: 'icon icon-arrow-up',
  complete: 'icon icon-check-gou-xuan',
  cancel: 'icon icon-close',
  close: 'icon icon-close',
  delete: 'icon icon-delete',
  clear: 'icon icon-clear',
  success: 'icon icon-circle-check',
  info: 'icon icon-info',
  warning: 'icon icon-warning',
  error: 'icon icon-error',
  prev: 'icon icon-arrow-back',
  next: 'icon icon-arrow-forward',
  checkboxOn: 'icon icon-check-gou-xuan',
  checkboxOff: 'icon icon-check',
  checkboxIndeterminate: 'icon icon-circle-minus',
  delimiter: 'icon icon-dot',
  sortAsc: 'icon icon-arrow-up',
  sortDesc: 'icon icon-arrow-down',
  expand: 'icon icon-arrow-down',
  menu: 'icon icon-menu',
  subgroup: 'icon icon-arrow-down',
  dropdown: 'icon icon-arrow-down',
  radioOn: 'icon icon-radio',
  radioOff: 'icon icon-radio',
  edit: 'icon icon-editor',
  ratingEmpty: 'icon icon-dot',
  ratingFull: 'icon icon-circle-check',
  ratingHalf: 'icon icon-circle-check',
  loading: 'icon icon-refresh',
  first: 'icon icon-arrow-back',
  last: 'icon icon-arrow-forward',
  unfold: 'icon icon-arrow-down',
  file: 'icon icon-file',
  plus: 'icon icon-add',
  minus: 'icon icon-circle-minus',
  calendar: 'icon icon-calendar',
  treeviewCollapse: 'icon icon-arrow-down',
  treeviewExpand: 'icon icon-arrow-forward',
  tableGroupCollapse: 'icon icon-arrow-down',
  tableGroupExpand: 'icon icon-arrow-forward',
  eyeDropper: 'icon icon-tian-se',
  upload: 'icon icon-download',
  color: 'icon icon-tian-se',
  command: 'icon icon-keyboard',
  ctrl: 'icon icon-keyboard',
  shift: 'icon icon-arrow-up',
  alt: 'icon icon-keyboard',
  space: 'icon icon-keyboard',
  enter: 'icon icon-corner-down-left',
  arrowup: 'icon icon-arrow-up',
  arrowdown: 'icon icon-arrow-down',
  arrowleft: 'icon icon-arrow-back',
  arrowright: 'icon icon-arrow-forward',
  backspace: 'icon icon-clear',
  play: 'icon icon-play',
  pause: 'icon icon-circle-stop',
  fullscreen: 'icon icon-fullscreen',
  fullscreenExit: 'icon icon-enlarge',
  volumeHigh: 'icon icon-audio',
  volumeMedium: 'icon icon-audio',
  volumeLow: 'icon icon-audio',
  volumeOff: 'icon icon-audio',
  search: 'icon icon-search'
} as const;

const wsIconSet = {
  component: VClassIcon
};

export const vuetify = createVuetify({
  icons: {
    defaultSet: 'ws',
    aliases,
    sets: {
      ws: wsIconSet
    }
  },
  theme: {
    defaultTheme: DEFAULT_THEME_IDS.dark,
    themes: createVuetifyBootstrapThemes()
  }
});
