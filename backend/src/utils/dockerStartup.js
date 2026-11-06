export function isDockerUnavailableError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES') {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('docker.sock')
    || message.includes('docker daemon')
    || message.includes('cannot connect to the docker daemon')
    || message.includes('docker_engine')
    || message.includes('the system cannot find the file specified')
  );
}

function isTruthyFlag(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

export function shouldContinueWithoutDocker({ nodeEnv, dockerRequired, error } = {}) {
  if (isTruthyFlag(dockerRequired)) {
    return false;
  }

  if (String(nodeEnv || '').trim().toLowerCase() === 'production') {
    return false;
  }

  return isDockerUnavailableError(error);
}
