Сертификаты для GigaChat

Windows-установщик 0.4.2 автоматически включает корневой и выпускающий сертификаты
Минцифры в app/certs/russian_trusted_root_ca_pem.crt. Устанавливать сертификаты
в системное хранилище Windows не нужно. При обновлении ключи и диалоги сохраняются.

Сборка скачивает публичные сертификаты по HTTPS с проверкой сервера:
https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt
Источник ссылок: https://developers.sber.ru/docs/ru/gigachat/certificates
Проверяются формат PEM, имена CA, сроки действия, подпись корня и выпускающего CA.
Отпечатки SHA256 записываются в журнал сборки. При ошибке сборка останавливается.

В режиме разработки скачайте оба сертификата с официального портала Госуслуг
https://www.gosuslugi.ru/crt и выполните из корня проекта:
node scripts/prepare-gigachat-certs.mjs root.crt sub.crt certs/russian_trusted_root_ca_pem.crt
Либо укажите свой PEM-файл в caFile настроек GigaChat.

Встроенный набор автоматически используется только для официальных адресов GigaChat,
даже со старыми настройками профиля. Явный caFile сохраняет прежнее поведение.
Проверка TLS не отключается. Для остальных провайдеров ничего не меняется.
