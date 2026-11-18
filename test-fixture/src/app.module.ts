import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from '@app/users/users.module';
@Module({ imports: [AuthModule, UsersModule] })
export class AppModule {}
