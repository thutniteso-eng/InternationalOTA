import { Global, Module } from '@nestjs/common';
import { LocaleService } from './locale.service.js';

@Global()
@Module({
  providers: [LocaleService],
  exports: [LocaleService],
})
export class I18nModule {}
