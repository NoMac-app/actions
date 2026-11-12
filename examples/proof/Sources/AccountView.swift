import SwiftUI

struct AccountView: View {
    @Environment(Account.self) private var account
    @State private var email = ""
    @State private var password = ""
    @State private var message = ""

    var body: some View {
        NavigationStack {
            Form {
                if let signedIn = account.email {
                    Text("Signed in as \(signedIn)").accessibilityIdentifier("signedIn")
                    Button("Sign Out") { account.email = nil }.accessibilityIdentifier("signOut")
                } else {
                    TextField("Email", text: $email)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .accessibilityIdentifier("email")
                    SecureField("Password", text: $password).accessibilityIdentifier("password")
                    Button("Sign In") {
                        if email.contains("@") && password.count >= 4 { account.email = email; message = "" } else { message = "Check the email and password." }
                    }
                    .accessibilityIdentifier("signIn")
                    if !message.isEmpty { Text(message).accessibilityIdentifier("message") }
                }
            }
            .navigationTitle("Account")
        }
    }
}
