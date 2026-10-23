<!-- File purpose: provides the shared application tooltip with a directional arrow. -->
<script setup lang="ts">
import { computed } from 'vue';

/** Supported tooltip locations and their matching arrow directions. */
type WsTooltipLocation = 'top' | 'bottom' | 'left' | 'right';

interface WsTooltipProps {
  /** Text displayed in the tooltip overlay. */
  text: string;
  /** Side of the activator where the overlay is placed. */
  location?: WsTooltipLocation;
  /** Delay in milliseconds before the overlay opens; defaults to 3000ms. */
  openDelay?: number;
  /** Keeps the activator interactive while suppressing the tooltip overlay. */
  disabled?: boolean;
}

const props = withDefaults(defineProps<WsTooltipProps>(), {
  location: 'top',
  openDelay: 900,
  disabled: false
});

const contentClassName = computed(() => [
  'ws-tooltip',
  `ws-tooltip--${props.location}`
]);
</script>

<template>
  <v-tooltip
    :content-class="contentClassName"
    :disabled="props.disabled"
    :location="props.location"
    :open-delay="props.openDelay"
    :text="props.text"
  >
    <template #activator="{ props: tooltipProps }">
      <slot name="activator" :props="tooltipProps" />
    </template>
  </v-tooltip>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

:global(.v-overlay__content.ws-tooltip) {
  --ws-tooltip-surface: rgb(var(--v-theme-surface-variant));

  display: inline-flex;
  align-items: center;
  height: $tooltip-height !important;
  min-height: $tooltip-height !important;
  max-height: $tooltip-height !important;
  box-sizing: border-box;
  position: relative;
  padding: $tooltip-padding-y $tooltip-padding-x !important;
  color: rgb(var(--v-theme-on-surface-variant));
  line-height: $tooltip-line-height !important;
  background: var(--ws-tooltip-surface);
}

:global(.ws-tooltip::before) {
  position: absolute;
  border: $tooltip-arrow-size solid transparent;
  content: '';
  pointer-events: none;

}

:global(.ws-tooltip--top::before),
:global(.ws-tooltip--bottom::before) {
  left: 50%;
  transform: translateX(-50%);

}

:global(.ws-tooltip--left::before),
:global(.ws-tooltip--right::before) {
  top: 50%;
  transform: translateY(-50%);
}

:global(.ws-tooltip--top::before) {
  bottom: -($tooltip-arrow-size * 2);
  top: auto;
  right: auto;
  border-top-color: var(--ws-tooltip-surface);
}

:global(.ws-tooltip--bottom::before) {
  top: -($tooltip-arrow-size * 2);
  right: auto;
  bottom: auto;
  border-bottom-color: var(--ws-tooltip-surface);
}

:global(.ws-tooltip--left::before) {
  right: -($tooltip-arrow-size * 2);
  bottom: auto;
  left: auto;
  border-left-color: var(--ws-tooltip-surface);
}

:global(.ws-tooltip--right::before) {
  left: -($tooltip-arrow-size * 2);
  top: auto;
  right: auto;
  border-right-color: var(--ws-tooltip-surface);
}

// Vuetify may flip a connected tooltip when the preferred side overflows.
// Its final anchor origin is exposed as an inline CSS custom property.
:global(.ws-tooltip[style*="anchor-origin: top"]::before) {
  top: auto;
  right: auto;
  bottom: -($tooltip-arrow-size * 2);
  left: 50%;
  transform: translateX(-50%);
  border-color: transparent;
  border-top-color: var(--ws-tooltip-surface);
}

:global(.ws-tooltip[style*="anchor-origin: bottom"]::before) {
  top: -($tooltip-arrow-size * 2);
  right: auto;
  bottom: auto;
  left: 50%;
  transform: translateX(-50%);
  border-color: transparent;
  border-bottom-color: var(--ws-tooltip-surface);
}

:global(.ws-tooltip[style*="anchor-origin: left"]::before) {
  top: 50%;
  right: -($tooltip-arrow-size * 2);
  bottom: auto;
  left: auto;
  transform: translateY(-50%);
  border-color: transparent;
  border-left-color: var(--ws-tooltip-surface);
}

:global(.ws-tooltip[style*="anchor-origin: right"]::before) {
  top: 50%;
  right: auto;
  bottom: auto;
  left: -($tooltip-arrow-size * 2);
  transform: translateY(-50%);
  border-color: transparent;
  border-right-color: var(--ws-tooltip-surface);
}
</style>
