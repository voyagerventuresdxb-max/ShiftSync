-- CreateIndex
CREATE INDEX "attendance_logs_user_id_clock_in_at_idx" ON "attendance_logs"("user_id", "clock_in_at");

-- CreateIndex
CREATE INDEX "join_requests_phone_status_idx" ON "join_requests"("phone", "status");

-- CreateIndex
CREATE UNIQUE INDEX "policy_documents_file_url_key" ON "policy_documents"("file_url");

