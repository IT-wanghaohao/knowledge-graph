import { createApp } from 'vue'
import '@xyflow/vue/style.css'
import './style.css'
import App from './App.vue'

// The workspace owns graph selection and document lifetime.
createApp(App).mount('#app')
