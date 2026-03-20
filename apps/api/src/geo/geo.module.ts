import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { GeoService } from './geo.service';

@Module({
  imports: [DbModule],
  providers: [GeoService],
  exports: [GeoService],
})
export class GeoModule {}
