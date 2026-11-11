import { Controller, Get } from '@nestjs/common';

export interface HealthStatusResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthStatusResponse {
    return { status: 'ok' };
  }
}
