# 1C CF Compare (frontend + backend)

## Запуск
```bash
docker-compose up --build
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8080
- Workspace для задач: `./work` (в контейнере `/work`)

## Как пользоваться
1. Откройте UI на `localhost:3000`.
2. Выберите `left.cf` и `right.cf`.
3. Нажмите **Compare**.
4. Дождитесь статуса DONE и изучайте дерево объектов, фильтры и diff.

## API
- `POST /api/compare` — загрузка 2 файлов (`leftFile`, `rightFile`).
- `GET /api/compare/{jobId}` — статус и summary.
- `GET /api/compare/{jobId}/objects` — объекты метаданных.
- `GET /api/compare/{jobId}/object/{objectId}` — детали объекта.
- `GET /api/compare/{jobId}/diff?path=...` — unified diff/бинарный статус.
- `DELETE /api/compare/{jobId}` — удалить задачу и workspace.
- `GET /api/health`, `GET /api/version`.

## Очистка
- Автоочистка по TTL (по умолчанию 2 часа).
- Ручная очистка через `DELETE /api/compare/{jobId}`.

## Заметки по обработке .cf
- Бэкенд принимает `.cf`/`.cfe`/`.epf`.
- Сохраняет входные файлы в `workspace/{jobId}/input`.
- Делает raw-распаковку контейнера и пытается установить/вызвать `v8unpack` в контейнере.
- Если `v8unpack` недоступен/ошибка — автоматически применяется fallback на сравнение распакованных/сырых файлов.
