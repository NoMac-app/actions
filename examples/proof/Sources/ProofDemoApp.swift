import SwiftUI

/// NoMac Proof's sample: a shop, its cart and an account, each a file of its own, so a pull request that changes one
/// runs the flow that covers it (.nomac/flows).
@main
struct ProofDemoApp: App {
    @State private var cart = Cart()
    @State private var account = Account()

    var body: some Scene {
        WindowGroup {
            TabView {
                ShopView().tabItem { Label("Shop", systemImage: "bag") }
                CartView().tabItem { Label("Cart", systemImage: "cart") }
                AccountView().tabItem { Label("Account", systemImage: "person") }
            }
            .environment(cart)
            .environment(account)
        }
    }
}

struct Product: Identifiable, Hashable {
    let name: String
    let cents: Int
    var id: String { name }
    var price: String { String(format: "$%.2f", Double(cents) / 100) }
}

let products = [Product(name: "Espresso", cents: 300), Product(name: "Croissant", cents: 250), Product(name: "Juice", cents: 400)]

@MainActor @Observable
final class Cart {
    var items: [Product] = []
    var ordered = false
    var total: String { String(format: "$%.2f", Double(items.reduce(0) { $0 + $1.cents }) / 100) }
}

@MainActor @Observable
final class Account {
    var email: String?
}
