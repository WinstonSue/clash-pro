const message = new URL(location.href).searchParams.get('status');
if (message) {
  document.querySelector('#status').textContent = `${message} 可从菜单栏选择「重试启动本机服务」。`;
}
