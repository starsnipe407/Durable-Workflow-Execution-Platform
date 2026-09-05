import { execSync } from 'node:child_process';

console.log('Resetting test database...');
try {
  execSync(
    'docker compose exec -T postgres-test psql -U postgres -c "DROP DATABASE IF EXISTS durable_workflow_test;" -c "CREATE DATABASE durable_workflow_test;"',
    { stdio: 'inherit' }
  );
  console.log('Test database reset successfully.');
} catch (err) {
  console.error('Failed to reset test database:', err.message);
  process.exit(1);
}
