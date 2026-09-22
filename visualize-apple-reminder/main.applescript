tell application "Reminders"
	set output to ""
	set theList to list "Daily Goal" -- Replace "YourListName" with the name of your list
	set theReminders to reminders in theList
	log "load reminder"
	repeat with aReminder in theReminders
		set isCompleted to completed of aReminder
		set dueDate to due date of aReminder
		log aReminder
		if dueDate is not missing value then
			log (dueDate as string) & ", " & isCompleted -- This prints the reminder to the log
			set output to output & (dueDate as string) & ", " & isCompleted & "
"
		end if
	end repeat
end tell

-- Writing output to a file
set filePath to (path to desktop as text) & "reminders_output.txt" -- You can change the file path as needed
set fileRef to open for access file filePath with write permission
try
	set eof of fileRef to 0 -- Clear the file if it exists
	write output to fileRef starting at eof
	close access fileRef
on error
	close access fileRef
end try